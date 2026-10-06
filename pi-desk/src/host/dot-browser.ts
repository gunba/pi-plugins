import { readFileSync } from "node:fs";
import { join } from "node:path";
import WebSocket from "ws";
import { DOT_NATIVE, type NativeDotSnapshot } from "./dot-native.ts";
import type { DotDownload } from "../shared/dot.ts";
import { DOT_DOWNLOADS } from "./dot-downloads.ts";

type Pending = { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
interface CdpEvent { method: string; params: any; sessionId?: string }

/** A task-owned tab for explicitly opened native controls, never the chat transport. */
export class DotBrowser {
	private socket?: WebSocket;
	private sequence = 0;
	private pending = new Map<number, Pending>();
	private session?: string;
	private target?: string;
	private listeners = new Set<(event: CdpEvent) => void>();
	private agentDir: string;
	constructor(agentDir: string) { this.agentDir = agentDir; }

	onEvent(listener: (event: CdpEvent) => void): () => void {
		this.listeners.add(listener); return () => { this.listeners.delete(listener); };
	}
	async open(path = "/"): Promise<void> {
		if (path !== "/" && !/^\/dots\/[a-zA-Z0-9_~-]+$/.test(path)) throw Error("Invalid native Dot conversation path.");
		let endpoint = "http://127.0.0.1:9222";
		try { endpoint = JSON.parse(readFileSync(join(this.agentDir, "pi-chrome-devtools.json"), "utf8")).browser?.endpoint ?? endpoint; }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw Error("Chrome settings could not be read."); }
		const url = new URL(endpoint);
		if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username || url.password)
			throw Error("Dot requires a local Chrome DevTools connection.");
		const response = await fetch(new URL("/json/version", url), { signal: AbortSignal.timeout(5_000), redirect: "error" });
		if (!response.ok) throw Error("Chrome DevTools is unavailable. Open Chrome through Pi's browser tools.");
		const version = await response.json() as { webSocketDebuggerUrl?: string };
		const socketUrl = new URL(version.webSocketDebuggerUrl ?? "");
		if (socketUrl.protocol !== "ws:" || socketUrl.hostname !== url.hostname || socketUrl.port !== url.port)
			throw Error("Chrome returned a different debugging endpoint.");
		const socket = this.socket = new WebSocket(socketUrl.href, { maxPayload: 8 * 1024 * 1024, handshakeTimeout: 5_000 });
		socket.on("message", data => {
			const frame = JSON.parse(data.toString());
			const pending = this.pending.get(frame.id);
			if (pending) {
				clearTimeout(pending.timer); this.pending.delete(frame.id);
				frame.error ? pending.reject(Error(frame.error.message)) : pending.resolve(frame.result);
			} else if (frame.sessionId === this.session) for (const listener of this.listeners) listener(frame);
		});
		socket.on("close", () => {
			for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(Error("Chrome disconnected.")); }
			this.pending.clear();
			for (const listener of this.listeners) listener({ method: "closed", params: {} });
		});
		socket.on("error", () => {});
		await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
		const target = await this.call("Target.createTarget", { url: "about:blank", background: true }, false);
		this.target = target.targetId;
		this.session = (await this.call("Target.attachToTarget", { targetId: this.target, flatten: true }, false)).sessionId;
		await this.call("Network.enable");
		await this.call("Page.enable");
		await this.call("Emulation.setFocusEmulationEnabled", { enabled: true });
		await this.call("Page.addScriptToEvaluateOnNewDocument", { source: `if (location.origin === 'https://chatgpt.com') { ${DOT_NATIVE}; ${DOT_DOWNLOADS}; }` });
		await this.call("Page.navigate", { url: `https://chatgpt.com${path}` });
		const deadline = Date.now() + 30_000;
		while (Date.now() < deadline) {
			const ready = await this.call("Runtime.evaluate", { expression: "location.origin === 'https://chatgpt.com' && document.readyState !== 'loading'", returnByValue: true });
			if (ready.result?.value) break;
			await new Promise(resolve => setTimeout(resolve, 300));
		}
		await this.evaluate(DOT_NATIVE);
		await this.evaluate(DOT_DOWNLOADS);
	}
	async call(method: string, params: Record<string, unknown> = {}, attached = true): Promise<any> {
		const socket = this.socket;
		if (!socket || socket.readyState !== WebSocket.OPEN) throw Error("Chrome is not connected.");
		return new Promise((resolve, reject) => {
			const id = ++this.sequence;
			const timer = setTimeout(() => { this.pending.delete(id); reject(Error("Chrome request timed out.")); }, 30_000);
			this.pending.set(id, { resolve, reject, timer });
			socket.send(JSON.stringify({ id, method, params, ...(attached ? { sessionId: this.session } : {}) }));
		});
	}
	async evaluate<T>(expression: string): Promise<T> {
		const result = await this.call("Runtime.evaluate", { expression: `if (location.origin !== "https://chatgpt.com") throw Error("The native view left ChatGPT. Reconnect Dot.");\n${expression}`, awaitPromise: true, returnByValue: true });
		if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description?.split("\n")[0] ?? "Dot browser operation failed.");
		return result.result.value as T;
	}
	async validateDot(dot: string): Promise<void> {
		if (await this.evaluate("window.__piDeskDotNative.context().room.aeon_id") !== dot) throw Error("The native Dot changed. Reconnect before continuing.");
	}
	async snapshot(): Promise<NativeDotSnapshot> {
		return this.evaluate("window.__piDeskDotNative.snapshot()");
	}
	async select(): Promise<NativeDotSnapshot> {
		const deadline = Date.now() + 30_000;
		let clicked = 0;
		while (Date.now() < deadline) {
			try { await this.evaluate(DOT_NATIVE); return await this.snapshot(); } catch {}
			if (Date.now() - clicked > 1500) {
				clicked = Date.now();
				await this.evaluate(`(() => {
					const primary = window.__piDeskDotNative?.primary();
					const link = primary && [...document.querySelectorAll('a[href]')].find(node => node.pathname === primary.path && node.origin === location.origin);
					const button = document.querySelector('button[data-sidebar-destination="builtin:orbit"]');
					if (link && location.pathname !== primary.path) link.click(); else if (button && !location.pathname.startsWith('/dots/')) button.click();
				})()`);
			}
			await new Promise(resolve => setTimeout(resolve, 300));
		}
		throw Error("Open your existing Dot in this Chrome profile, then reconnect. Native sign-in or verification may be required.");
	}
	async downloads(): Promise<DotDownload[]> {
		return this.evaluate("window.__piDeskDotDownloads.list()");
	}
	async downloadChunk(id: string, offset: number): Promise<{ data: string; next: number; size: number }> {
		return this.evaluate(`window.__piDeskDotDownloads.chunk(${JSON.stringify(id)}, ${JSON.stringify(offset)})`);
	}
	async releaseDownload(id: string): Promise<void> {
		await this.evaluate(`window.__piDeskDotDownloads.remove(${JSON.stringify(id)})`);
	}
	async close(): Promise<void> {
		if (this.target && this.socket?.readyState === WebSocket.OPEN) {
			// A tab repurposed outside the Dot route belongs to its new activity.
			const info = await this.call("Target.getTargetInfo", { targetId: this.target }, false).catch(() => undefined);
			const url = info?.targetInfo?.url ? new URL(info.targetInfo.url) : undefined;
			if (url && (url.href === "about:blank" || url.origin === "https://chatgpt.com" && (url.pathname === "/" || url.pathname.startsWith("/dots/"))))
				await this.call("Target.closeTarget", { targetId: this.target }, false).catch(() => {});
		}
		this.target = undefined; this.socket?.close(); this.socket = undefined;
	}
}
