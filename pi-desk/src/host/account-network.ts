import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { ProxyAgent } from "proxy-agent";
import type { INetworkModule, NetworkRequestOptions, NetworkResponse } from "@azure/msal-node";
import { createRemoteJWKSet, customFetch } from "jose";
import type { AccountConfiguration } from "../shared/account.ts";
import { CredentialVerifier } from "../shared/device-credential.ts";

/** Uses normal Node TLS trust and the same proxy policy as the outbound relay. */
export class AccountNetwork implements INetworkModule {
	private agent: ProxyAgent;
	constructor(proxy?: string) {
		this.agent = proxy ? new ProxyAgent({ getProxyForUrl: () => proxy }) : new ProxyAgent();
	}
	async request<T>(method: "GET" | "POST", address: string, options?: NetworkRequestOptions & { signal?: AbortSignal }, timeout = 20_000): Promise<NetworkResponse<T>> {
		const url = new URL(address);
		if (url.username || url.password || url.hash || !(url.protocol === "https:"
			|| url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname))) {
			throw new Error("Account requests require HTTPS or a loopback address.");
		}
		const contents = options?.body ?? "";
		if (Buffer.byteLength(contents) > 1024 * 1024) throw new Error("Account request is too large.");
		return new Promise((resolve, reject) => {
			const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
				method, agent: this.agent, signal: options?.signal, headers: { ...options?.headers,
					...(method === "POST" ? { "Content-Length": String(Buffer.byteLength(contents)) } : {}) },
			}, response => {
				const parts: Buffer[] = [];
				let length = 0;
				response.on("data", part => {
					const bytes = Buffer.from(part);
					if ((length += bytes.length) > 1024 * 1024) {
						response.destroy(new Error("Account response is too large.")); return;
					}
					parts.push(bytes);
				});
				response.on("error", reject);
				response.on("end", () => {
					try {
						if (response.statusCode! >= 300 && response.statusCode! < 400) throw new Error("Account endpoint redirected.");
						const body = JSON.parse(Buffer.concat(parts).toString("utf8")) as T;
						const headers = Object.fromEntries(Object.entries(response.headers)
							.filter((entry): entry is [string, string | string[]] => entry[1] !== undefined)
							.map(([key, value]) => [key, Array.isArray(value) ? value.join(", ") : value]));
						resolve({ body, headers, status: response.statusCode! });
					} catch { reject(new Error("Account endpoint returned an unreadable response.")); }
				});
			});
			const timer = setTimeout(() => request.destroy(new Error("Account request timed out.")),
				Math.max(1000, Math.min(timeout, 60_000)));
			timer.unref();
			request.once("close", () => clearTimeout(timer));
			request.on("error", () => reject(new Error("Account connection failed. Check TLS trust, proxy and network policy.")));
			request.end(contents);
		});
	}
	sendGetRequestAsync<T>(url: string, options?: NetworkRequestOptions, timeout?: number): Promise<NetworkResponse<T>> {
		return this.request<T>("GET", url, options, timeout);
	}
	sendPostRequestAsync<T>(url: string, options?: NetworkRequestOptions): Promise<NetworkResponse<T>> {
		return this.request<T>("POST", url, options);
	}
	verifier(config: AccountConfiguration): CredentialVerifier {
		return new CredentialVerifier(config, createRemoteJWKSet(new URL("/.well-known/jwks.json", config.origin), {
			timeoutDuration: 10_000, cooldownDuration: 30_000, cacheMaxAge: 10 * 60_000,
			[customFetch]: async (url, options) => {
				const result = await this.request("GET", String(url), {
					headers: Object.fromEntries(new Headers(options.headers)), signal: options.signal ?? undefined,
				});
				return new Response(JSON.stringify(result.body), { status: result.status, headers: result.headers });
			},
		}));
	}
	close(): void { this.agent.destroy(); }
}
