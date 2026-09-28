import { request } from "node:https";
import { createWriteStream } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { IncomingMessage } from "node:http";
import { ProxyAgent } from "proxy-agent";

const execute = promisify(execFile);
function githubURL(address: string): URL {
	const url = new URL(address);
	if (url.protocol !== "https:" || url.username || url.password || url.hash
		|| !["github.com", "api.github.com"].includes(url.hostname) && !url.hostname.endsWith(".githubusercontent.com"))
		throw new Error("Runtime downloads must come from GitHub.");
	return url;
}
/** Reuse the configured GitHub proxy without changing Git or account settings. */
export async function githubProxy(source: string): Promise<string | undefined> {
	try {
		const value = (await execute("git", ["config", "--get-urlmatch", "http.proxy", "https://github.com/gunba/pi-plugins"],
			{ cwd: source, encoding: "utf8", windowsHide: true })).stdout.trim();
		return value || undefined;
	} catch { return undefined; }
}
export class ReleaseNetwork {
	private agent: ProxyAgent;
	private signal?: AbortSignal;
	constructor(proxy?: string, signal?: AbortSignal) {
		this.agent = proxy ? new ProxyAgent({ getProxyForUrl: () => proxy }) : new ProxyAgent(); this.signal = signal;
	}
	private deadline(timeout: number): AbortSignal {
		const deadline = AbortSignal.timeout(timeout);
		return this.signal ? AbortSignal.any([this.signal, deadline]) : deadline;
	}
	private async response(address: string, signal: AbortSignal, redirects = 0): Promise<IncomingMessage> {
		const url = githubURL(address);
		const response = await new Promise<IncomingMessage>((accept, reject) => {
			const req = request(url, { agent: this.agent, signal, headers: {
				"User-Agent": "Pi-Desk", Accept: url.hostname === "api.github.com" ? "application/vnd.github+json" : "application/octet-stream",
				...(url.hostname === "api.github.com" ? { "X-GitHub-Api-Version": "2022-11-28" } : {}),
			} }, accept);
			req.once("error", error => {
				const code = (error as NodeJS.ErrnoException).code;
				reject(new Error(`GitHub connection failed${code && /^[A-Z0-9_]+$/.test(code) ? ` (${code})` : ""}. Check TLS trust, proxy and network access.`));
			});
			req.end();
		});
		if ([301, 302, 303, 307, 308].includes(response.statusCode!)) {
			const location = response.headers.location;
			response.destroy();
			if (!location || redirects >= 4) throw new Error("GitHub download redirected too many times.");
			return this.response(new URL(location, url).href, signal, redirects + 1);
		}
		if (response.statusCode !== 200) {
			response.destroy();
			throw new Error(response.headers["x-ratelimit-remaining"] === "0"
				? "GitHub release lookup is rate limited. Try again later."
				: `GitHub returned HTTP ${response.statusCode}. The running release is unchanged.`);
		}
		return response;
	}
	async json(address: string): Promise<unknown> {
		const response = await this.response(address, this.deadline(30_000));
		const chunks: Buffer[] = []; let bytes = 0;
		for await (const chunk of response) {
			if ((bytes += chunk.length) > 4 * 1024 * 1024) { response.destroy(); throw new Error("GitHub release metadata is too large."); }
			chunks.push(Buffer.from(chunk));
		}
		try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
		catch { throw new Error("GitHub returned invalid release metadata."); }
	}
	async download(address: string, file: string, size: number): Promise<void> {
		const signal = this.deadline(10 * 60_000), response = await this.response(address, signal);
		let received = 0;
		const limit = new Transform({ transform(chunk, _encoding, callback) {
			received += chunk.length;
			callback(received > size ? new Error("Runtime download exceeded its published size.") : undefined, chunk);
		} });
		await pipeline(response, limit, createWriteStream(file, { flags: "wx", mode: 0o600 }), { signal });
		if (received !== size) throw new Error("Runtime download is incomplete.");
	}
	close(): void { this.agent.destroy(); }
}
