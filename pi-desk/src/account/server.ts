import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
	accountConfiguration, deviceKey, identifier, MEMBERSHIP_LEASE, workspaceIdentity,
	type AccountConfiguration, type DeviceKind, type WorkspaceDevice,
} from "../shared/account.ts";
import { AccountProofs } from "../shared/account-proof.ts";
import { AccountError, DeviceAuthority, MicrosoftAccess } from "./identity.ts";
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
}
export class AccountServer {
	readonly config: AccountConfiguration;
	private store: AccountStore;
	private authority: DeviceAuthority;
	private access: MicrosoftAccess;
	private proofs = new AccountProofs();
	private active = 0;
	private allowance = 60;
	private allowanceTime = Date.now();
	private closing = false;
	private server = createServer({ maxHeaderSize: 32 * 1024 }, (request, response) => {
		void this.handle(request, response);
	});

	private constructor(config: AccountConfiguration, store: AccountStore, authority: DeviceAuthority, access: MicrosoftAccess) {
		this.config = config; this.store = store; this.authority = authority; this.access = access;
		this.server.requestTimeout = 20_000;
		this.server.headersTimeout = 10_000;
		this.server.keepAliveTimeout = 5000;
		this.server.maxConnections = 128;
		this.server.maxRequestsPerSocket = 100;
	}
	static async open(options: AccountServerOptions, access?: MicrosoftAccess): Promise<AccountServer> {
		const config = accountConfiguration(options.config);
		const authority = await DeviceAuthority.open(config, options.signingKey);
		const store = await AccountStore.open(options.directory, config);
		return new AccountServer(config, store, authority, access ?? new MicrosoftAccess(config));
	}
	async listen(port: number, address = "127.0.0.1"): Promise<number> {
		await new Promise<void>((resolve, reject) => {
			this.server.once("error", reject);
			this.server.listen(port, address, () => { this.server.off("error", reject); resolve(); });
		});
		return (this.server.address() as AddressInfo).port;
	}
	private reply(response: ServerResponse, status: number, value: unknown): void {
		if (response.destroyed || response.writableEnded) return;
		response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
		response.end(JSON.stringify(value));
	}
	private rate(): boolean {
		const now = Date.now();
		this.allowance = Math.min(60, this.allowance + (now - this.allowanceTime) / 100);
		this.allowanceTime = now;
		if (this.allowance < 1 || this.active >= 32) return false;
		this.allowance--;
		return true;
	}
	private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		response.setHeader("Cache-Control", "no-store");
		response.setHeader("X-Content-Type-Options", "nosniff");
		response.setHeader("Referrer-Policy", "no-referrer");
		response.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
		response.setHeader("Vary", "Origin");
		let admitted = false;
		try {
			if (this.closing) throw new AccountError(503, "account_service_stopping");
			if (request.headers.host !== new URL(this.config.origin).host || !request.url?.startsWith("/")
				|| request.url.startsWith("//")) throw new AccountError(403, "invalid_origin");
			const url = new URL(request.url, this.config.origin);
			if (url.origin !== this.config.origin || url.search || url.hash) throw new AccountError(400, "invalid_request_url");
			const origin = request.headers.origin;
			if (origin) {
				if (!this.config.appOrigins.includes(origin)) throw new AccountError(403, "invalid_origin");
				response.setHeader("Access-Control-Allow-Origin", origin);
				response.setHeader("Access-Control-Allow-Methods", "GET, POST");
				response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Pi-Desk-Proof");
				response.setHeader("Access-Control-Expose-Headers", "Retry-After");
			}
			if (request.method === "OPTIONS") {
				if (!origin) throw new AccountError(403, "invalid_origin");
				response.writeHead(204); response.end(); return;
			}
			if (request.method === "GET" && url.pathname === "/health") {
				this.store.assertAvailable();
				this.reply(response, 200, { status: "ok", service: "pi-desk-account", version: 1 }); return;
			}
			if (!this.rate()) { response.setHeader("Retry-After", "1"); throw new AccountError(429, "account_service_busy"); }
			this.active++; admitted = true;
			if (request.method === "GET" && url.pathname === "/config") {
				this.reply(response, 200, this.config); return;
			}
			if (request.method === "GET" && url.pathname === "/.well-known/jwks.json") {
				this.reply(response, 200, { keys: [this.authority.publicKey] }); return;
			}
			const identity = await this.access.authenticate(request.headers.authorization);
			if (request.method === "GET" && url.pathname === "/workspace") {
				const snapshot = this.store.snapshot();
				this.reply(response, 200, { account: workspaceIdentity(this.config), revision: snapshot.revision,
					devices: snapshot.devices.filter(device => device.revoked === undefined).map(device => ({
						...device, online: device.connected && Date.now() - device.seen < 90_000,
					})) }); return;
			}
			if (request.method !== "POST") throw new AccountError(404, "not_found");
			const input = await body(request);
			const proof = async (device: Pick<WorkspaceDevice, "id" | "key">) => {
				try {
					await this.proofs.verify(request.headers["x-pi-desk-proof"], {
						id: device.id, method: "POST", url: url.href, body: input.raw,
						accessToken: request.headers.authorization!.slice(7),
					}, device.key);
				} catch { throw new AccountError(403, "invalid_device_proof"); }
			};
			if (url.pathname === "/devices/enrol") {
				const deviceId = id(input.value.id);
				if (!["host", "browser"].includes(String(input.value.kind)) || typeof input.value.name !== "string") {
					throw new AccountError(400, "invalid_device");
				}
				let key;
				try { key = (await deviceKey(input.value.key)).key; }
				catch { throw new AccountError(400, "invalid_device_key"); }
				await proof({ id: deviceId, key });
				const device = await this.store.enrol({ id: deviceId, kind: input.value.kind as DeviceKind,
					name: input.value.name, key });
				this.reply(response, 200, { device, ...await this.authority.credential(device, identity) }); return;
			}
			const route = /^\/devices\/([^/]+)\/(credential|heartbeat|lease|rename|revoke)$/.exec(url.pathname);
			if (!route) throw new AccountError(404, "not_found");
			const deviceId = id(route[1]);
			// An account owner may rename/remove any enrolment; device operations require its key.
			if (route[2] === "revoke") {
				await this.store.revoke(deviceId); this.reply(response, 200, { revoked: true }); return;
			}
			if (route[2] === "rename") {
				await this.store.rename(deviceId, input.value.name); this.reply(response, 200, { renamed: true }); return;
			}
			const device = this.store.device(deviceId);
			await proof(device);
			if (route[2] === "credential") {
				this.reply(response, 200, await this.authority.credential(this.store.device(deviceId), identity)); return;
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
			this.reply(response, 200, { allowed,
				expires: Math.min(identity.expires, Math.floor(Date.now() / 1000) + MEMBERSHIP_LEASE) });
		} catch (error) {
			const known = error instanceof AccountError;
			this.reply(response, known ? error.status : 500, { error: known ? error.code : "account_service_error" });
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
