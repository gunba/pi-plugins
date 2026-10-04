import { readFileSync } from "node:fs";
import { join } from "node:path";
import WebSocket from "ws";

type Pending = { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
interface CdpEvent { method: string; params: any; sessionId?: string }

/** A task-owned tab. Credentials and send verification remain inside ChatGPT. */
export class DotBrowser {
	private socket?: WebSocket;
	private sequence = 0;
	private pending = new Map<number, Pending>();
	private session?: string;
	private target?: string;
	private listeners = new Set<(event: CdpEvent) => void>();
	constructor(private agentDir: string) {}

	onEvent(listener: (event: CdpEvent) => void): () => void {
		this.listeners.add(listener); return () => { this.listeners.delete(listener); };
	}
	async open(): Promise<void> {
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
		await this.call("Page.navigate", { url: "https://chatgpt.com/" });
		const deadline = Date.now() + 30_000;
		while (Date.now() < deadline) {
			if (await this.evaluate("Boolean(window.__reactRouterManifest?.routes?.root?.module)")) break;
			await new Promise(resolve => setTimeout(resolve, 300));
		}
		await this.evaluate(`(async () => {
			const root = window.__reactRouterManifest?.routes?.root?.module;
			if (!root) throw Error('Open ChatGPT in Chrome and sign in, then reconnect Dot.');
			const source = await (await fetch(root)).text();
			const match = /import\\{__webpack_require__[^}]*\\}from["']([^"']+)["']/.exec(source);
			if (!match) throw Error('ChatGPT web runtime changed.');
			const runtimeUrl = new URL(match[1], new URL(root, location.href));
			if (runtimeUrl.origin !== location.origin) throw Error('Unexpected ChatGPT runtime.');
			const { __webpack_require__: require } = await import(runtimeUrl.href);
			const request = Object.values(require.c).map(module => module.exports)
				.find(exports => typeof exports?.Request?.safeGet === 'function')?.Request;
			if (!request) throw Error('ChatGPT request client is unavailable.');
			window.__piDeskDot = { request };
		})()`);
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
		const result = await this.call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
		if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description?.split("\n")[0] ?? "Dot browser operation failed.");
		return result.result.value as T;
	}
	async read(path: string, parameters: Record<string, unknown> = {}): Promise<any> {
		return this.evaluate(`window.__piDeskDot.request.safeGet(${JSON.stringify(path)}, { parameters: ${JSON.stringify(parameters)} })`);
	}
	async select(name: string): Promise<void> {
		const deadline = Date.now() + 15_000;
		let selected = false;
		while (Date.now() < deadline) {
			if (!selected) selected = await this.evaluate(`(() => {
				const button = [...document.querySelectorAll('button')].find(node => node.textContent.trim() === ${JSON.stringify(name)});
				if (!button) return false;
				button.click(); return true;
			})()`);
			if (selected && await this.evaluate("location.pathname.startsWith('/dots/') && Boolean(document.querySelector('[role=textbox][aria-label=\"Message\"]'))")) return;
			await new Promise(resolve => setTimeout(resolve, 200));
		}
		throw Error("The Dot message editor did not open. Open your Dot in this Chrome profile, then reconnect.");
	}
	async prepare(text: string): Promise<void> {
		await this.evaluate(`(() => {
			const editor = document.querySelector('[role=textbox][aria-label="Message"]');
			if (!editor || editor.textContent.trim()) throw Error('Dot already has a draft; open ChatGPT to review it.');
			editor.focus({ preventScroll: true });
			if (!document.execCommand('insertText', false, ${JSON.stringify(text)})) throw Error('Dot editor insertion failed.');
		})()`);
		await new Promise(resolve => setTimeout(resolve, 100));
	}
	async submit(text: string): Promise<boolean> {
		return this.evaluate(`(() => {
			const editor = document.querySelector('[role=textbox][aria-label="Message"]');
			const doc = editor?.pmViewDesc?.node;
			if (doc?.textBetween(0, doc.content.size, '\\n').trim() !== ${JSON.stringify(text.trim())}) return false;
			let container = editor.parentElement;
			while (container && !container.querySelector('button[aria-label="Send"]')) container = container.parentElement;
			const button = container?.querySelector('button[aria-label="Send"]');
			if (!button || button.disabled) return false;
			button.click(); return true;
		})()`);
	}
	async close(): Promise<void> {
		if (this.target && this.socket?.readyState === WebSocket.OPEN) {
			await this.call("Target.closeTarget", { targetId: this.target }, false).catch(() => {});
		}
		this.target = undefined; this.socket?.close(); this.socket = undefined;
	}
}
