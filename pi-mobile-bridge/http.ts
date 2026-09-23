import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { endpointPath } from "./registry.ts";

const MAX_REQUEST = 64 * 1024;
const MAX_RESPONSE = 1024 * 1024;

export function secureHeaders(response: ServerResponse): void {
	response.setHeader("Cache-Control", "no-store");
	response.setHeader("X-Content-Type-Options", "nosniff");
	response.setHeader("X-Frame-Options", "DENY");
	response.setHeader("Referrer-Policy", "no-referrer");
	response.setHeader("Content-Security-Policy",
		"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'");
}

export function json(response: ServerResponse, code: number, data: unknown): void {
	response.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
	response.end(JSON.stringify(data));
}

export async function readBody(request: IncomingMessage): Promise<Buffer> {
	let bytes = 0;
	const parts: Buffer[] = [];
	for await (const part of request) {
		const buffer = Buffer.isBuffer(part) ? part : Buffer.from(part);
		bytes += buffer.length;
		if (bytes > MAX_REQUEST) throw new Error("Request too large");
		parts.push(buffer);
	}
	return Buffer.concat(parts);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export async function callSession(
	id: string, path: string, method = "GET", body?: Buffer,
): Promise<{ code: number; body: Buffer }> {
	return new Promise((resolve, reject) => {
		const request = httpRequest({
			socketPath: endpointPath(id), path, method,
			headers: body ? { "Content-Type": "application/json", "Content-Length": body.length } : undefined,
		}, response => {
			let bytes = 0;
			const parts: Buffer[] = [];
			response.on("data", (part: Buffer) => {
				bytes += part.length;
				if (bytes > MAX_RESPONSE) { request.destroy(new Error("Session response too large")); return; }
				parts.push(part);
			});
			response.on("end", () => resolve({ code: response.statusCode ?? 502, body: Buffer.concat(parts) }));
			response.on("error", reject);
		});
		request.setTimeout(8000, () => request.destroy(new Error("Session did not respond")));
		request.on("error", reject);
		request.end(body);
	});
}
