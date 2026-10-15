import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { decodeJwt } from "jose";
import {
	accountConfiguration, deviceKey, identifier, MEMBERSHIP_LEASE, workspaceIdentity,
	type AccountConfiguration, type DeviceKey, type DeviceKind, type WorkspaceDevice,
} from "../shared/account.ts";
import { AccountProofs } from "../shared/account-proof.ts";
import { AccountError, DeviceAuthority, GoogleOwner, ownerSettings, randomToken, type OwnerSettings } from "./identity.ts";
import { AccountStore } from "./store.ts";

const MAX_BODY = 16 * 1024;
function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new AccountError(400, "invalid_request");
	return value as Record<string, unknown>;
}
function id(value: unknown): string {
	try { return identifier(value); } catch { throw new AccountError(400, "invalid_device_id"); }
}
async function body(request: IncomingMessage): Promise<{ raw: string; value: Record<string, unknown> }> {
	if (request.headers["content-type"]?.split(";")[0].trim() !== "application/json"
		|| Number(request.headers["content-length"] ?? 0) > MAX_BODY) throw new AccountError(400, "invalid_request_body");
	const parts: Buffer[] = [];
	let length = 0;
	for await (const part of request) {
		const bytes = Buffer.from(part);
		if ((length += bytes.length) > MAX_BODY) throw new AccountError(413, "request_too_large");
		parts.push(bytes);
	}
	const raw = Buffer.concat(parts).toString("utf8");
	try { return { raw, value: object(JSON.parse(raw)) }; }
	catch { throw new AccountError(400, "invalid_request_body"); }
}

export interface AccountServerOptions {
	config: AccountConfiguration;
	directory: string;
	signingKey: unknown;
	owner: OwnerSettings;
}
/** A device waiting for the owner's approval. Pending enrolments live only in memory and expire after ten minutes. */
interface PendingEnrolment {
	id: string; kind: DeviceKind; name: string; key: DeviceKey; code: string; expires: number; returnTo?: string;
	attempt?: { state: string; nonce: string; verifier: string };
	approval?: string;
}
const ENROLMENT_MS = 10 * 60_000;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
async function form(request: IncomingMessage): Promise<URLSearchParams> {
	if (request.headers["content-type"]?.split(";")[0].trim() !== "application/x-www-form-urlencoded") throw new AccountError(400, "invalid_request_body");
	let raw = "";
	for await (const part of request) { raw += part; if (raw.length > 4096) throw new AccountError(413, "request_too_large"); }
	return new URLSearchParams(raw);
}

export class AccountServer {
	readonly config: AccountConfiguration;
	private store: AccountStore;
	private authority: DeviceAuthority;
	private google: GoogleOwner;
	private proofs = new AccountProofs();
	private pending = new Map<string, PendingEnrolment>();
	private states = new Map<string, string>();
	private active = 0;
	private allowance = 60;
	private allowanceTime = Date.now();
	private closing = false;
	private server = createServer({ maxHeaderSize: 32 * 1024 }, (request, response) => {
		void this.handle(request, response);
	});

	private constructor(config: AccountConfiguration, store: AccountStore, authority: DeviceAuthority, google: GoogleOwner) {
		this.config = config; this.store = store; this.authority = authority; this.google = google;
		this.server.requestTimeout = 20_000;
		this.server.headersTimeout = 10_000;
		this.server.keepAliveTimeout = 5000;
		this.server.maxConnections = 128;
		this.server.maxRequestsPerSocket = 100;
	}
	static async open(options: AccountServerOptions, google?: GoogleOwner): Promise<AccountServer> {
		const config = accountConfiguration(options.config);
		const authority = await DeviceAuthority.open(config, options.signingKey);
		const store = await AccountStore.open(options.directory, config);
		return new AccountServer(config, store, authority, google ?? new GoogleOwner(ownerSettings(options.owner)));
	}
	async listen(port: number, address = "127.0.0.1"): Promise<number> {
		await new Promise<void>((resolve, reject) => {
			this.server.once("error", reject);
			this.server.listen(port, address, () => { this.server.off("error", reject); resolve(); });
		});
		return (this.server.address() as AddressInfo).port;
	}
	private get callback(): string { return `${this.config.origin}/auth/google/callback`; }
	private reply(response: ServerResponse, status: number, value: unknown): void {
		if (response.destroyed || response.writableEnded) return;
		response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
		response.end(JSON.stringify(value));
	}
	private page(response: ServerResponse, status: number, title: string, body: string, refresh?: string): void {
		if (response.destroyed || response.writableEnded) return;
		// The approval form posts back here; under no-referrer, browsers send `Origin: null` with it.
		response.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Referrer-Policy": "same-origin",
			"Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'" });
		response.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
${refresh ? `<meta http-equiv="refresh" content="1;url=${escapeHtml(refresh)}">` : ""}<title>${escapeHtml(title)} · Pi Desk</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#222}.code{font:600 1.6rem ui-monospace,monospace;letter-spacing:.1em}button{font:inherit;padding:.5rem 1.2rem;margin-right:.5rem}</style>
</head><body><h1>${escapeHtml(title)}</h1>${body}</body></html>`);
	}
	private rate(): boolean {
		const now = Date.now();
		this.allowance = Math.min(60, this.allowance + (now - this.allowanceTime) / 100);
		this.allowanceTime = now;
		if (this.allowance < 1 || this.active >= 32) return false;
		this.allowance--;
		return true;
	}
	/** An enrolled device signing this exact request with its key. */
	private async device(request: IncomingMessage, url: URL, raw: string): Promise<WorkspaceDevice> {
		const proof = request.headers["x-pi-desk-proof"];
		let claimed: unknown;
		try { claimed = typeof proof === "string" ? decodeJwt(proof).device : undefined; } catch { /* rejected below */ }
		if (typeof claimed !== "string") throw new AccountError(401, "device_proof_required");
		const device = this.store.device(id(claimed));
		try {
			await this.proofs.verify(proof, { id: device.id, method: request.method!, url: url.href, body: raw, accessToken: "" }, device.key);
		} catch { throw new AccountError(403, "invalid_device_proof"); }
		return device;
	}
	private prune(): void {
		const now = Date.now();
		for (const [key, value] of this.pending) if (value.expires <= now) this.pending.delete(key);
		for (const [state, key] of this.states) if (!this.pending.has(key)) this.states.delete(state);
	}
	private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		response.setHeader("Cache-Control", "no-store");
		response.setHeader("X-Content-Type-Options", "nosniff");
		response.setHeader("Referrer-Policy", "no-referrer");
		response.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
		response.setHeader("Vary", "Origin");
		let admitted = false, html = false;
		try {
			if (this.closing) throw new AccountError(503, "account_service_stopping");
			if (request.headers.host !== new URL(this.config.origin).host || !request.url?.startsWith("/")
				|| request.url.startsWith("//")) throw new AccountError(403, "invalid_origin");
			const url = new URL(request.url, this.config.origin);
			html = url.pathname.startsWith("/enrol/") || url.pathname === "/auth/google/callback";
			if (url.origin !== this.config.origin || url.hash || url.search && url.pathname !== "/auth/google/callback") {
				throw new AccountError(400, "invalid_request_url");
			}
			const origin = request.headers.origin;
			// Approval forms post from this service's own pages; the app calls it cross-origin.
			if (origin && origin !== this.config.origin) {
				if (!this.config.appOrigins.includes(origin)) throw new AccountError(403, "invalid_origin");
				response.setHeader("Access-Control-Allow-Origin", origin);
				response.setHeader("Access-Control-Allow-Methods", "GET, POST");
				response.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Pi-Desk-Proof");
				response.setHeader("Access-Control-Expose-Headers", "Retry-After");
			}
			if (request.method === "OPTIONS") {
				if (!origin) throw new AccountError(403, "invalid_origin");
				response.writeHead(204); response.end(); return;
			}
			if (request.method === "GET" && url.pathname === "/health") {
				this.store.assertAvailable();
				this.reply(response, 200, { status: "ok", service: "pi-desk-account", version: 2 }); return;
			}
			if (!this.rate()) { response.setHeader("Retry-After", "1"); throw new AccountError(429, "account_service_busy"); }
			this.active++; admitted = true;
			if (request.method === "GET" && url.pathname === "/config") {
				this.reply(response, 200, this.config); return;
			}
			if (request.method === "GET" && url.pathname === "/.well-known/jwks.json") {
				this.reply(response, 200, { keys: [this.authority.publicKey] }); return;
			}
			const enrolment = /^\/enrol\/([\w-]{43})(\/approve)?$/.exec(url.pathname);
			if (enrolment && request.method === "GET" && !enrolment[2]) {
				// The owner's browser opens the approval link; Google sign-in comes first.
				this.prune();
				const pending = this.pending.get(enrolment[1]!);
				if (!pending) throw new AccountError(404, "enrolment_expired");
				const attempt = await this.google.start(this.callback);
				if (pending.attempt) this.states.delete(pending.attempt.state);
				pending.attempt = { state: attempt.state, nonce: attempt.nonce, verifier: attempt.verifier };
				this.states.set(attempt.state, enrolment[1]!);
				response.writeHead(302, { Location: attempt.url }); response.end(); return;
			}
			if (request.method === "GET" && url.pathname === "/auth/google/callback") {
				this.prune();
				const state = url.searchParams.get("state") ?? "", key = this.states.get(state);
				this.states.delete(state);
				const pending = key ? this.pending.get(key) : undefined;
				if (!pending?.attempt || pending.attempt.state !== state) throw new AccountError(400, "enrolment_expired");
				const attempt = pending.attempt; pending.attempt = undefined;
				const code = url.searchParams.get("code");
				if (!code || url.searchParams.has("error")) throw new AccountError(401, "sign_in_cancelled");
				const owner = await this.google.finish(code, attempt, this.callback);
				await this.store.owner(owner.subject);
				pending.approval = randomToken();
				const what = pending.kind === "host" ? "computer" : "browser";
				this.page(response, 200, `Approve this ${what}?`, `<p>Signed in as ${escapeHtml(owner.email)}.</p>
<p>A ${what} named <strong>${escapeHtml(pending.name)}</strong> asked to join your Pi Desk workspace. Approve it only if it shows this code:</p>
<p class="code">${escapeHtml(pending.code)}</p>
<form method="post" action="/enrol/${key}/approve"><input type="hidden" name="approval" value="${pending.approval}">
<button name="decision" value="approve">Approve</button><button name="decision" value="deny">Deny</button></form>`);
				return;
			}
			if (enrolment && request.method === "POST" && enrolment[2]) {
				const input = await form(request), pending = this.pending.get(enrolment[1]!);
				if (!pending?.approval || input.get("approval") !== pending.approval || pending.expires <= Date.now()) {
					throw new AccountError(400, "enrolment_expired");
				}
				pending.approval = undefined; this.pending.delete(enrolment[1]!);
				if (input.get("decision") !== "approve") { this.page(response, 200, "Not approved", "<p>The device was not added. You can close this window.</p>"); return; }
				await this.store.enrol({ id: pending.id, kind: pending.kind, name: pending.name, key: pending.key });
				this.page(response, 200, "Approved", pending.returnTo
					? `<p><strong>${escapeHtml(pending.name)}</strong> can now connect. Returning to Pi Desk…</p>`
					: `<p><strong>${escapeHtml(pending.name)}</strong> can now connect. You can close this window.</p>`, pending.returnTo);
				return;
			}
			if (request.method === "GET" && url.pathname === "/workspace") {
				await this.device(request, url, "");
				const snapshot = this.store.snapshot();
				this.reply(response, 200, { account: workspaceIdentity(this.config), revision: snapshot.revision,
					devices: snapshot.devices.filter(device => device.revoked === undefined).map(device => ({
						...device, online: device.connected && Date.now() - device.seen < 90_000,
					})) }); return;
			}
			if (request.method !== "POST") throw new AccountError(404, "not_found");
			const input = await body(request);
			if (url.pathname === "/enrolments") {
				// A device asks to join, proving it holds the key it presents; the owner approves it with Google.
				const deviceId = id(input.value.id), kind = input.value.kind;
				if ((kind !== "host" && kind !== "browser") || typeof input.value.name !== "string" || !input.value.name.trim()
					|| input.value.name.length > 100 || /[\u0000-\u001f\u007f]/.test(input.value.name)) throw new AccountError(400, "invalid_device");
				let key: DeviceKey, thumbprint: string;
				try { ({ key, thumbprint } = await deviceKey(input.value.key)); }
				catch { throw new AccountError(400, "invalid_device_key"); }
				try {
					await this.proofs.verify(request.headers["x-pi-desk-proof"], { id: deviceId, method: "POST", url: url.href, body: input.raw, accessToken: "" }, key);
				} catch { throw new AccountError(403, "invalid_device_proof"); }
				const existing = this.store.snapshot().devices.find(device => device.id === deviceId);
				if (existing?.revoked !== undefined) throw new AccountError(403, "device_revoked");
				if (existing) {
					if (existing.thumbprint !== thumbprint || existing.kind !== kind) throw new AccountError(409, "device_identity_changed");
					this.reply(response, 200, { enrolled: true }); return;
				}
				const returnTo = input.value.returnTo;
				if (returnTo !== undefined && (kind !== "browser" || typeof returnTo !== "string" || !this.config.appOrigins.includes(returnTo))) {
					throw new AccountError(400, "invalid_return");
				}
				this.prune();
				if (this.pending.size >= 16) throw new AccountError(429, "too_many_enrolments");
				for (const [key2, value] of this.pending) if (value.id === deviceId) this.pending.delete(key2);
				const pendingKey = randomToken(), letters = crypto.getRandomValues(new Uint8Array(8));
				const code = [...letters].map(byte => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join("").replace(/^(.{4})/, "$1-");
				const expires = Date.now() + ENROLMENT_MS;
				this.pending.set(pendingKey, { id: deviceId, kind, name: input.value.name.trim(), key, code, expires,
					...(typeof returnTo === "string" ? { returnTo: `${returnTo}/` } : {}) });
				this.reply(response, 202, { approve: `${this.config.origin}/enrol/${pendingKey}`, code, expires }); return;
			}
			const route = /^\/devices\/([^/]+)\/(credential|heartbeat|lease|rename|revoke)$/.exec(url.pathname);
			if (!route) throw new AccountError(404, "not_found");
			const deviceId = id(route[1]);
			const device = await this.device(request, url, input.raw);
			// Any of the owner's devices may rename or remove an enrolment; device operations are its own.
			if (route[2] === "revoke") {
				await this.store.revoke(deviceId); this.reply(response, 200, { revoked: true }); return;
			}
			if (route[2] === "rename") {
				await this.store.rename(deviceId, input.value.name); this.reply(response, 200, { renamed: true }); return;
			}
			if (device.id !== deviceId) throw new AccountError(403, "invalid_device_proof");
			if (route[2] === "credential") {
				this.reply(response, 200, await this.authority.credential(this.store.device(deviceId))); return;
			}
			if (route[2] === "heartbeat") {
				if (device.kind !== "host") throw new AccountError(403, "host_required");
				if (typeof input.value.connected !== "boolean") throw new AccountError(400, "invalid_heartbeat");
				await this.store.touch(deviceId, input.value.connected);
				this.reply(response, 200, { accepted: true }); return;
			}
			if (!Array.isArray(input.value.peers) || input.value.peers.length > 32) throw new AccountError(400, "invalid_peers");
			const party = input.value.purpose === "party";
			if (input.value.purpose !== undefined && (!party || device.kind !== "host")) throw new AccountError(400, "invalid_lease_purpose");
			const snapshot = this.store.snapshot();
			// Re-read the host alongside peers after asynchronous proof verification.
			if (!snapshot.devices.some(item => item.id === deviceId && item.revoked === undefined)) {
				throw new AccountError(403, "device_revoked");
			}
			const allowed = input.value.peers.map(value => {
				const peer = object(value), peerId = id(peer.id);
				const record = snapshot.devices.find(item => item.id === peerId && item.id !== deviceId && item.kind === (party ? "host" : device.kind === "host" ? "browser" : "host")
					&& item.revoked === undefined && item.thumbprint === peer.thumbprint);
				return record?.id;
			}).filter((value): value is string => !!value);
			this.reply(response, 200, { allowed, expires: Math.floor(Date.now() / 1000) + MEMBERSHIP_LEASE });
		} catch (error) {
			const known = error instanceof AccountError;
			const status = known ? error.status : 500, code = known ? error.code : "account_service_error";
			if (html) this.page(response, status, "Pi Desk sign-in", `<p>${escapeHtml({
				enrolment_expired: "This approval link has expired or was already used. Start again from the device.",
				sign_in_cancelled: "Sign-in was cancelled.",
				workspace_access_denied: "That Google account does not own this workspace.",
			}[code] ?? "The request could not be completed. Start again from the device.")}</p>`);
			else this.reply(response, status, { error: code });
		} finally {
			if (admitted) this.active--;
			// Do not leave an unauthorized upload occupying a keep-alive connection.
			if (!request.complete) request.resume();
		}
	}
	async close(): Promise<void> {
		this.closing = true;
		await new Promise<void>(resolve => this.server.close(() => resolve()));
		await this.store.close();
	}
}
