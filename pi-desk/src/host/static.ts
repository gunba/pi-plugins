import type { ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

const mime: Record<string, string> = {
	".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
	".svg": "image/svg+xml", ".png": "image/png", ".webmanifest": "application/manifest+json",
};
export function securityHeaders(response: ServerResponse, pathname?: string): void {
	response.setHeader("X-Content-Type-Options", "nosniff");
	response.setHeader("Referrer-Policy", "no-referrer");
	response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
	response.setHeader("Content-Security-Policy", pathname === SANDBOX_PAGE ? SANDBOX_POLICY : contentSecurityPolicy());
}
/** The page that runs HTML an agent shows (public/sandbox.html). */
export const SANDBOX_PAGE = "/sandbox.html";
/**
 * Inline scripts and styles run, but nothing loads from or connects to anywhere, and the sandbox gives the page an
 * opaque origin: it cannot reach Desk's storage or API. The app's own frame-src 'self' keeps the frame from being
 * navigated to another site.
 */
export const SANDBOX_POLICY = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; "
	+ "frame-ancestors 'self'; base-uri 'none'; form-action 'none'; sandbox allow-scripts";
export function contentSecurityPolicy(options: { socketOrigin?: string; accountOrigin?: string } = {}): string {
	// The website also connects to a host on the browser's own computer directly (RemoteClient).
	const connections = [options.socketOrigin, options.accountOrigin].filter(Boolean).map(origin => ` ${new URL(origin!).origin}`).join("")
		+ (options.socketOrigin ? " ws://127.0.0.1:*" : "");
	return `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'${connections}; frame-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`;
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
