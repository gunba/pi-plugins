import type { ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

const mime: Record<string, string> = {
	".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
	".svg": "image/svg+xml", ".png": "image/png", ".webmanifest": "application/manifest+json",
};
export function securityHeaders(response: ServerResponse): void {
	response.setHeader("X-Content-Type-Options", "nosniff");
	response.setHeader("Referrer-Policy", "no-referrer");
	response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
	response.setHeader("Content-Security-Policy", contentSecurityPolicy());
}
export function contentSecurityPolicy(options: { socketOrigin?: string; accountOrigin?: string; authCallback?: boolean } = {}): string {
	const microsoft = options.accountOrigin ? " https://login.microsoftonline.com https://login.live.com" : "";
	const connections = [options.socketOrigin, options.accountOrigin].filter(Boolean).map(origin => ` ${new URL(origin!).origin}`).join("");
	return `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'${connections}${microsoft}; frame-src 'self'${microsoft}; object-src 'none'; frame-ancestors ${options.authCallback ? "'self'" : "'none'"}; base-uri 'none'; form-action 'self'${microsoft}`;
}
export async function serveClient(directory: string, pathname: string, response: ServerResponse): Promise<void> {
	try {
		const path = resolve(directory, `.${decodeURIComponent(pathname === "/" ? "/index.html" : pathname)}`);
		if (!path.startsWith(`${directory}${sep}`) || !mime[extname(path)] || !(await stat(path)).isFile()) throw new Error("Not found");
		response.writeHead(200, { "Content-Type": mime[extname(path)], "Cache-Control":
			pathname.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache" });
		response.end(await readFile(path));
	} catch { response.writeHead(404, { "Content-Type": "text/plain" }); response.end("Not found"); }
}
