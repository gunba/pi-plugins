import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { SessionLease, SessionOwnedError, sessionLockPath } from "./lease.ts";

interface Handoff { session: string; port: number; token: string }
// Capabilities stay in the user's profile, even for a shared session directory.
const location = (file: string) => join(homedir(), ".pi", "agent", "session-handoffs", `${basename(sessionLockPath(file))}.json`);

/** Only the terminal owner publishes a control endpoint; Desk workers do not. */
export async function desktopHandoff(lease: SessionLease, current: () => boolean, prepare: () => () => void): Promise<{ close(): void }> {
	const file = location(lease.file), session = basename(sessionLockPath(lease.file));
	const token = randomBytes(32).toString("hex"), authorization = Buffer.from(`Bearer ${token}`);
	let closed = false, requested = false;
	const server = createServer((req, res) => {
		const presented = Buffer.from(req.headers.authorization ?? "");
		if (closed || req.method !== "POST" || req.url !== "/takeover" || req.headers.origin
			|| req.headers["x-pi-session"] !== session || presented.length !== authorization.length
			|| !timingSafeEqual(presented, authorization)) { res.writeHead(403).end(); return; }
		if (!current()) { res.writeHead(409).end(); return; }
		let shutdown: (() => void) | undefined;
		if (!requested) {
			// Mark the owner as transferring synchronously, before another input
			// or session-switch event can be admitted.
			try { shutdown = prepare(); requested = true; }
			catch { res.writeHead(409).end(); return; }
		}
		// Flush admission before native shutdown closes this control socket.
		res.writeHead(202).end(() => shutdown?.());
	});
	server.requestTimeout = 5_000; server.headersTimeout = 5_000;
	server.maxConnections = 8;
	const close = () => {
		if (closed) return;
		closed = true; server.close(); server.closeAllConnections();
		try {
			if ((JSON.parse(readFileSync(file, "utf8")) as Handoff).token === token) unlinkSync(file);
		} catch { /* A crash or replacement owner may already have removed this record. */ }
	};
	try {
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
		});
		server.unref();
		if (!current()) { close(); return { close }; }
		const port = (server.address() as { port: number }).port;
		// Holding the lease makes any previous endpoint record stale. Exclusive
		// creation also avoids following a pre-existing metadata symlink.
		mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
		try { unlinkSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		writeFileSync(file, JSON.stringify({ session, port, token } satisfies Handoff), { mode: 0o600, flag: "wx" });
		return { close };
	} catch (error) { close(); throw error; }
}

/** Ask the exact desktop owner to quit, then obtain the ordinary OS lease. */
export async function resumeLease(file: string, { takeover = false, signal }: { takeover?: boolean; signal: AbortSignal }): Promise<{ lease: SessionLease; desktop: boolean }> {
	signal.throwIfAborted();
	try { return { lease: new SessionLease(file), desktop: false }; }
	catch (error) { if (!(error instanceof SessionOwnedError) || !takeover) throw error; }
	const session = basename(sessionLockPath(file));
	let endpoint: Handoff;
	try {
		endpoint = JSON.parse(readFileSync(location(file), "utf8")) as Handoff;
		if (endpoint.session !== session || !Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535
			|| typeof endpoint.token !== "string" || !/^[a-f0-9]{64}$/.test(endpoint.token)) throw new Error("Invalid desktop endpoint");
	} catch {
		throw new Error("This session is open in another Pi process that does not support desktop takeover. Update the desktop extension and reload it, or close that session manually. Other Desk workers cannot be taken over.");
	}
	try {
		await new Promise<void>((resolve, reject) => {
			// A direct loopback request must not send the capability through a proxy.
			const req = request({ hostname: "127.0.0.1", port: endpoint.port, path: "/takeover", method: "POST",
				headers: { Authorization: `Bearer ${endpoint.token}`, "X-Pi-Session": session, Connection: "close" },
				signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
			}, response => {
				response.resume();
				response.once("error", reject);
				response.once("end", () => response.statusCode === 202 ? resolve() : reject(new Error("Desktop owner changed or declined takeover")));
			});
			req.once("error", reject); req.end();
		});
	} catch (error) {
		signal.throwIfAborted();
		// The process may have exited before its acknowledgement reached us.
		try { return { lease: new SessionLease(file), desktop: true }; }
		catch (lockError) { if (!(lockError instanceof SessionOwnedError)) throw lockError; }
		throw new Error(`Desktop Pi could not complete the takeover request. Close that session manually and resume again. ${error instanceof Error ? error.message : String(error)}`);
	}
	const deadline = Date.now() + 60_000;
	while (true) {
		signal.throwIfAborted();
		try { return { lease: new SessionLease(file), desktop: true }; }
		catch (error) { if (!(error instanceof SessionOwnedError)) throw error; }
		if (Date.now() >= deadline) throw new Error("Desktop Pi is still shutting down. Desk has not opened the file. Wait for its work to stop, then resume again.");
		await delay(100, undefined, { signal });
	}
}
