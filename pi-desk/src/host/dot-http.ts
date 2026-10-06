import { request as httpsRequest } from "node:https";
import type { IncomingMessage } from "node:http";
import { open, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { DOT_FILE_BYTES } from "../shared/dot.ts";
import { ProxyAgent } from "proxy-agent";
import WebSocket from "ws";
import type { DotAuthorize } from "./dot-auth.ts";

export class DotHttpError extends Error {
	readonly status: number;
	readonly challenge: boolean;
	constructor(status: number, challenge = false) {
		super(challenge ? "ChatGPT requires additional verification for this Dot request."
			: status === 401 ? "Dot's sign-in was rejected. Sign into its account again in Settings."
			: status === 403 ? "This account cannot perform that Dot operation."
			: status === 404 ? "This Dot is not available to the selected account."
			: status === 429 ? "Dot is receiving too many requests. Wait before trying again."
			: `Dot returned HTTP ${status}.`);
		this.status = status; this.challenge = challenge;
	}
}
export interface DotJsonOptions {
	body?: unknown;
	signal?: AbortSignal;
	/** Persist the request identity before any bytes can be sent. */
	onDispatch?: () => void;
}

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export interface DotAssetOptions { maximum: number; signal?: AbortSignal }
interface RequestOptions {
	method: Method; authenticated: boolean; signal?: AbortSignal; accept?: string;
	body?: Buffer | Readable; contentType?: string; length?: number; timeout?: number; onDispatch?: () => void;
}
const responseMime = (response: IncomingMessage) => (response.headers["content-type"] ?? "application/octet-stream").split(";")[0].trim().toLowerCase();
function backend(path: string): URL {
	if (!path.startsWith("/") || path.length > 4096) throw Error("Invalid Dot request path.");
	const url = new URL(`https://chatgpt.com/backend-api${path}`);
	if (url.origin !== "https://chatgpt.com" || !url.pathname.startsWith("/backend-api/") || url.hash)
		throw Error("Invalid Dot request destination.");
	return url;
}
function assetTarget(address: string): { url: URL; authenticated: boolean } {
	if (address.length > 16_384 || /[\\\x00-\x20\x7f]/.test(address)) throw Error("Dot returned an invalid file destination.");
	if (address.startsWith("/files/library/")) address = `/backend-api${address}`;
	if (address.startsWith("/__codex-api/")) address = `/backend-api/${address.slice(13)}`;
	let url: URL; try { url = new URL(address, "https://chatgpt.com"); } catch { throw Error("Dot returned an invalid file destination."); }
	if (url.protocol !== "https:" || url.username || url.password || url.hash || url.port && url.port !== "443") throw Error("Dot returned an unexpected file destination.");
	if (url.hostname === "chatgpt.com") {
		if (!/^\/backend-api\/estuary\/(?:content\/?|public_content\/enc\/[^/]+)$/.test(url.pathname)
			&& !/^\/backend-api\/files\/library\/content_download\/?$/.test(url.pathname)
			&& !/^\/backend-api\/files\/library\/files\/[^/]+\/(?:content_redirect|download_redirect|thumbnail_redirect|project_content)$/.test(url.pathname)
			&& !/^\/api\/library\/files\/[^/]+\/(?:content|download|thumbnail|project-content)$/.test(url.pathname))
			throw Error("This Dot file requires the native view.");
		return { url, authenticated: true };
	}
	if (!["oaiusercontent.com", "oaistatic.com"].some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`)) && url.hostname !== "cdn.openai.com")
		throw Error("This Dot file requires the native view.");
	return { url, authenticated: false };
}

/** Fixed API destinations; signed assets get no account headers outside ChatGPT. */
export class DotHttp {
	private agent: ProxyAgent;
	private abort = new AbortController();
	private authorize: DotAuthorize;
	private requester: typeof httpsRequest;
	constructor(authorize: DotAuthorize, proxy?: string, requester: typeof httpsRequest = httpsRequest) {
		this.authorize = authorize; this.requester = requester;
		this.agent = proxy ? new ProxyAgent({ getProxyForUrl: () => proxy }) : new ProxyAgent();
	}
	private async request(url: URL, options: RequestOptions): Promise<IncomingMessage> {
		const signal = options.signal ? AbortSignal.any([this.abort.signal, options.signal]) : this.abort.signal;
		signal.throwIfAborted();
		const auth = options.authenticated ? await this.authorize(signal) : undefined;
		signal.throwIfAborted();
		return new Promise((resolve, reject) => {
			options.onDispatch?.();
			const request = this.requester(url, { method: options.method, agent: this.agent, signal, headers: {
				...(auth ? { Authorization: `Bearer ${auth.token}`, "ChatGPT-Account-Id": auth.identity.accountId } : {}),
				Accept: options.accept ?? "application/json", "Accept-Encoding": "identity", "User-Agent": "Pi-Desk",
				...(options.body ? { "Content-Type": options.contentType!, "Content-Length": String(options.length!) } : {}),
			} }, response => {
				response.on("error", () => {}); // The async body reader reports errors without exposing signed URLs.
				resolve(response);
			});
			const timer = setTimeout(() => request.destroy(Error("Dot request timed out.")), options.timeout ?? 30_000);
			timer.unref(); request.once("close", () => { clearTimeout(timer); if (options.body instanceof Readable) options.body.destroy(); });
			request.on("error", () => reject(signal.aborted ? new DOMException("Dot request cancelled.", "AbortError")
				: Error("Dot connection failed. Check the network, TLS trust or proxy configuration.")));
			if (options.body instanceof Readable) {
				options.body.on("error", () => request.destroy(Error("Dot upload was interrupted."))); options.body.pipe(request);
			} else request.end(options.body);
		});
	}
	private validate(response: IncomingMessage, maximum: number): void {
		const status = response.statusCode ?? 0, length = response.headers["content-length"], encoding = response.headers["content-encoding"];
		let error: Error | undefined;
		if (status < 200 || status >= 300) error = new DotHttpError(status, response.headers["cf-mitigated"] === "challenge");
		else if (length && (!/^\d+$/.test(length) || Number(length) > maximum)) error = Error("Dot file or response exceeds the download limit. Use the native view for larger files.");
		else if (encoding && encoding !== "identity") error = Error("Dot returned an unsupported response encoding.");
		if (error) { response.destroy(); throw error; }
	}
	private async buffer(response: IncomingMessage, maximum: number): Promise<Buffer> {
		this.validate(response, maximum);
		const parts: Buffer[] = []; let size = 0;
		try {
			for await (const part of response) {
				const bytes = Buffer.from(part); size += bytes.length;
				if (size > maximum) throw Error("Dot response exceeds the download limit.");
				parts.push(bytes);
			}
		} catch { throw Error("Dot response was interrupted or exceeded its download limit."); }
		finally { response.destroy(); }
		return Buffer.concat(parts, size);
	}
	private async parse<T>(response: IncomingMessage): Promise<T> {
		const bytes = await this.buffer(response, 8 * 1024 * 1024);
		if (response.statusCode === 204 && !bytes.length) return undefined as T;
		try { return JSON.parse(bytes.toString("utf8")) as T; } catch { throw Error("Dot returned an unreadable response."); }
	}
	async json<T>(method: Method, path: string, options: DotJsonOptions = {}): Promise<T> {
		const url = backend(path), body = options.body === undefined ? undefined : Buffer.from(JSON.stringify(options.body));
		if (body && body.length > 512 * 1024) throw Error("Dot request is too large.");
		return this.parse<T>(await this.request(url, { method, authenticated: true, signal: options.signal,
			body, length: body?.length, contentType: "application/json", onDispatch: options.onDispatch }));
	}
	async upload<T>(path: string, file: { path: string; name: string; mime: string; size: number }, options: Omit<DotJsonOptions, "body"> = {}): Promise<T> {
		const url = backend(path);
		if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > DOT_FILE_BYTES || !/^[\w.+-]+\/[\w.+-]+$/.test(file.mime) || /\x00/.test(file.name))
			throw Error("Invalid Dot attachment.");
		const handle = await open(file.path, "r");
		let body: Readable | undefined;
		try {
			const info = await handle.stat();
			if (!info.isFile() || info.size !== file.size) throw Error("Staged Dot attachment size changed.");
			const boundary = `pi-desk-${randomUUID()}`, name = file.name.replace(/\r/g, "%0D").replace(/\n/g, "%0A").replace(/"/g, "%22");
			const prefix = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${file.mime}\r\n\r\n`);
			const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
			body = Readable.from((async function* () {
				yield prefix;
				const stream = handle.createReadStream({ autoClose: false, start: 0, end: file.size - 1 });
				try { for await (const part of stream) yield part; } finally { stream.destroy(); }
				yield suffix;
			})());
			return await this.parse<T>(await this.request(url, { method: "POST", authenticated: true, signal: options.signal, body,
				contentType: `multipart/form-data; boundary=${boundary}`, length: prefix.length + file.size + suffix.length, timeout: 120_000, onDispatch: options.onDispatch }));
		} finally { body?.destroy(); await handle.close(); }
	}
	private async assetResponse(address: string, options: DotAssetOptions): Promise<IncomingMessage> {
		if (!Number.isSafeInteger(options.maximum) || options.maximum < 1 || options.maximum > 128 * 1024 * 1024) throw Error("Invalid Dot download limit.");
		for (let redirects = 0; redirects <= 3; redirects++) {
			const { url, authenticated } = assetTarget(address);
			const response = await this.request(url, { method: "GET", authenticated, signal: options.signal, accept: "*/*", timeout: 120_000 });
			if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
				response.destroy();
				if (!response.headers.location || redirects === 3) throw Error("Dot file redirects could not be resolved.");
				try { address = new URL(response.headers.location, url).href; } catch { throw Error("Dot returned an invalid file redirect."); }
				continue;
			}
			this.validate(response, options.maximum); return response;
		}
		throw Error("Dot file redirects could not be resolved.");
	}
	async asset(address: string, options: DotAssetOptions): Promise<{ bytes: Buffer; mime: string }> {
		const response = await this.assetResponse(address, options);
		return { bytes: await this.buffer(response, options.maximum), mime: responseMime(response) };
	}
	async download(address: string, path: string, options: DotAssetOptions): Promise<{ size: number; mime: string }> {
		const response = await this.assetResponse(address, options);
		let handle: Awaited<ReturnType<typeof open>> | undefined, complete = false, size = 0;
		try {
			handle = await open(path, "wx", 0o600);
			for await (const part of response) {
				options.signal?.throwIfAborted(); this.abort.signal.throwIfAborted();
				const bytes = Buffer.from(part); size += bytes.length;
				if (size > options.maximum) throw Error("Dot file exceeds the download limit.");
				await handle.writeFile(bytes);
			}
			options.signal?.throwIfAborted(); this.abort.signal.throwIfAborted();
			complete = true; return { size, mime: responseMime(response) };
		} catch (error) {
			throw Error((error as NodeJS.ErrnoException).code === "ENOSPC" ? "Not enough disk space for this Dot attachment." : "Dot download did not complete. It may exceed the download limit.");
		} finally {
			response.destroy(); await handle?.close(); if (handle && !complete) await rm(path, { force: true });
		}
	}
	socket(address: string): WebSocket {
		const url = new URL(address);
		if (url.protocol !== "wss:" || url.hostname !== "ws.chatgpt.com" || url.username || url.password || url.hash || url.port && url.port !== "443")
			throw Error("Dot returned an unexpected live-update destination.");
		this.abort.signal.throwIfAborted();
		return new WebSocket(url.href, { agent: this.agent, maxPayload: 8 * 1024 * 1024, handshakeTimeout: 10_000, followRedirects: false });
	}
	close(): void { this.abort.abort(); this.agent.destroy(); }
}
