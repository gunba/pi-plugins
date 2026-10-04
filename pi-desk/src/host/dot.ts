import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { atomicJson } from "../../manage/store.ts";
import type { DotInput, DotMessage, DotSnapshot, DotSurfaceMode, DotSurfaceInput, DotSurfaceFrame, DotUpload } from "../shared/dot.ts";
import { DotBrowser } from "./dot-browser.ts";
import { DotFiles, dotUuid } from "./dot-files.ts";
import type { NativeDotMessage } from "./dot-native.ts";
import { DotSurface } from "./dot-surface.ts";

export function dotMessages(items: NativeDotMessage[], dot: string): DotMessage[] {
	return items.filter(message => !message.deletedAt && !message.deliveryState).map(message => ({
		id: message.id, author: message.senderAeonId === dot ? "dot" : message.self ? "owner" : "other",
		name: message.senderName, text: message.text ?? "", created: new Date(message.createdAt).toISOString(),
		attachments: (message.attachments ?? []).map(file => ({ id: file.attachmentId,
			name: file.name ?? file.title ?? "Attachment", kind: file.type, mime: file.mime, size: file.sizeBytes,
			downloadable: !!file.hasContent && file.contentType !== "video" })),
	}));
}
interface Config { enabled: boolean; dot?: string; name?: string; path?: string }
const uuid = dotUuid;
const validateIntent = (id: string, dot: string, text: string, files: string[]) => {
	if (!uuid(id) || typeof dot !== "string" || !dot || dot.length > 200 || typeof text !== "string" || !Array.isArray(files)
		|| files.length > 8 || new Set(files).size !== files.length || !files.every(file => typeof file === "string" && uuid(file))
		|| (!text.trim() && !files.length) || text.length > 32_000) throw Error("Enter a message or choose up to eight attachments. Dot messages can contain at most 32,000 characters.");
};
const sameIntent = (input: DotInput, dot: string, text: string, files: string[]) => {
	if (input.dot !== dot || input.text !== text || JSON.stringify(input.files ?? []) !== JSON.stringify(files)) throw Error("Dot message receipt was reused for different input.");
};

export class DotConnection {
	private browser?: DotBrowser;
	private config: Config;
	private snapshot: DotSnapshot = { state: "disconnected", messages: [], inputs: [] };
	private directory: string;
	private refreshing?: Promise<void>;
	private connecting?: Promise<void>;
	private sending?: Promise<void>;
	private surface?: DotSurface;
	private handoffs = new Set<string>();
	private handingOff?: Promise<void>;
	private clearingSurface?: Promise<void>;
	get busy(): boolean { return !!(this.connecting || this.sending || this.browsing || this.handingOff || this.clearingSurface || this.surface?.busy); }
	private browsing?: Promise<DotSurfaceFrame>;
	private room?: string;
	private dirty = true;
	private fetched = 0;
	private stopped = false;
	readonly files: DotFiles;

	private agentDir: string;
	constructor(dataDir: string, agentDir: string) {
		this.agentDir = agentDir;
		this.directory = join(dataDir, "dot");
		mkdirSync(this.directory, { recursive: true, mode: 0o700 });
		this.files = new DotFiles(this.directory);
		this.config = { enabled: false };
		try {
			try { this.config = JSON.parse(readFileSync(join(this.directory, "connection.json"), "utf8")); }
			catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
			if (typeof this.config?.enabled !== "boolean") throw Error("Invalid Dot connection settings.");
			const inputs = readdirSync(this.directory).filter(name => /^[a-f0-9-]{36}\.json$/.test(name)).map(name => {
				const input: DotInput = JSON.parse(readFileSync(join(this.directory, name), "utf8"));
				if (input.state === "sending") { input.state = "unknown"; input.error = "Desk stopped before delivery was confirmed. Check Dot before sending again."; this.save(input); }
				return input;
			}).sort((a, b) => b.created.localeCompare(a.created)).slice(0, 15);
			this.snapshot.inputs = inputs;
		} catch (error) {
			this.config = { enabled: false };
			this.snapshot = { ...this.snapshot, state: "unavailable", error: error instanceof Error ? error.message : String(error) };
		}
	}
	start(): void { if (this.config.enabled) void this.connect(false).catch(() => {}); }
	private save(input: DotInput): void { atomicJson(join(this.directory, `${input.id}.json`), input); }
	input(id: string): DotInput | undefined {
		if (!uuid(id)) throw Error("Invalid Dot message receipt.");
		try { return JSON.parse(readFileSync(join(this.directory, `${id}.json`), "utf8")); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	}
	private publish(input: DotInput): void {
		this.save(input); this.snapshot.inputs = [input, ...this.snapshot.inputs.filter(item => item.id !== input.id)].slice(0, 15);
	}
	async connect(explicit = true): Promise<void> {
		if (this.connecting) return this.connecting;
		if (this.busy) throw Error("Wait for the current Dot operation before reconnecting.");
		this.stopped = false;
		const job = this.open(explicit).finally(() => { if (this.connecting === job) this.connecting = undefined; });
		this.connecting = job; return job;
	}
	private async open(explicit: boolean): Promise<void> {
		await this.closeSurface();
		await this.browser?.close();
		this.snapshot = { state: "connecting", messages: [], inputs: this.snapshot.inputs };
		const browser = this.browser = new DotBrowser(this.agentDir);
		try {
			await browser.open(this.config.path);
			const native = await browser.select();
			if (!explicit && this.config.dot !== native.dot) throw Error("The signed-in Dot changed. Reconnect to choose it.");
			this.room = native.room;
			this.snapshot = { ...this.snapshot, state: "ready", id: native.dot, name: native.name };
			this.config = { enabled: true, dot: native.dot, name: native.name, path: native.path };
			atomicJson(join(this.directory, "connection.json"), this.config);
			browser.onEvent(event => {
				if (browser !== this.browser) return;
				if (event.method === "closed") this.snapshot = { ...this.snapshot, state: "unavailable", error: "Chrome disconnected. Reconnect Dot when Chrome is available." };
				if (event.method === "Network.webSocketFrameReceived" && typeof event.params.response?.payloadData === "string"
					&& event.params.response.payloadData.includes(this.room!)) this.dirty = true;
			});
			this.dirty = true; await this.refresh();
		} catch (error) {
			this.snapshot = { state: "unavailable", error: error instanceof Error ? error.message : String(error), messages: [], inputs: this.snapshot.inputs };
			await browser.close(); throw error;
		}
	}
	private async refresh(): Promise<void> {
		if (this.refreshing) return this.refreshing;
		const browser = this.browser, room = this.room, dot = this.snapshot.id;
		if (!browser || !room || !dot || this.snapshot.state !== "ready") return;
		const job = (async () => {
			this.dirty = false;
			const result = await browser.snapshot();
			if (browser !== this.browser || this.stopped) return;
			if (result.dot !== dot || result.room !== room) throw Error("The native Dot changed. Reconnect before continuing.");
			this.snapshot.name = result.name;
			this.snapshot.messages = dotMessages(result.messages.slice(-32), dot);
			this.snapshot.before = result.before; this.fetched = Date.now();
			for (const input of this.snapshot.inputs.filter(input => input.dot === dot && input.state === "unknown" && input.requestId)) {
				const found = result.messages.find(item => item.requestId === input.requestId && !item.deliveryState);
				if (found) {
					this.publish({ ...input, state: "accepted", messageId: found.id, error: undefined });
					for (const file of input.files ?? []) this.files.remove(file);
				}
			}
		})().catch(error => {
			this.snapshot = { ...this.snapshot, state: "unavailable", error: error instanceof Error ? error.message : String(error) };
		}).finally(() => { if (this.refreshing === job) this.refreshing = undefined; });
		this.refreshing = job; return job;
	}
	async view(): Promise<DotSnapshot> {
		if (this.dirty || Date.now() - this.fetched > 30_000) await this.refresh();
		return structuredClone({ ...this.snapshot, uploads: this.snapshot.id ? this.files.list(this.snapshot.id) : [] });
	}
	async history(before: string): Promise<{ messages: DotMessage[]; before?: string }> {
		if (this.snapshot.state !== "ready" || !this.room) throw Error("Reconnect Dot before loading history.");
		const result = await this.browser!.older(before);
		if (result.dot !== this.snapshot.id || result.room !== this.room) throw Error("The native Dot changed.");
		return { messages: dotMessages(result.messages, result.dot), before: result.before };
	}
	cancelInput(id: string, dot: string, text: string, files: string[] = []): DotInput {
		validateIntent(id, dot, text, files);
		const previous = this.input(id);
		if (previous) { sameIntent(previous, dot, text, files); return previous; }
		const input: DotInput = { id, dot, text, files, created: new Date().toISOString(), state: "not-sent", error: "Cancelled before admission. Your draft is retained." };
		this.publish(input); return input;
	}
	send(id: string, dot: string, text: string, files: string[] = []): DotInput {
		validateIntent(id, dot, text, files);
		const previous = this.input(id);
		if (previous) { sameIntent(previous, dot, text, files); return previous; }
		if (this.snapshot.state !== "ready" || this.snapshot.id !== dot) throw Error("Dot changed or disconnected. Reconnect before sending.");
		if (this.busy) throw Error("Wait for the current Dot operation.");
		if (this.surface || this.browsing) throw Error("Return from the native view before sending here.");
		this.files.forInput(dot, files);
		const input: DotInput = { id, dot, text, files, created: new Date().toISOString(), state: "sending" };
		this.publish(input);
		const job = this.deliver(input).catch(error => {
			this.snapshot = { ...this.snapshot, state: "unavailable", error: error instanceof Error ? error.message : String(error) };
		}).finally(() => { if (this.sending === job) this.sending = undefined; });
		this.sending = job; return input;
	}
	private async deliver(input: DotInput): Promise<void> {
		const browser = this.browser!, room = this.room!;
		let clicked = false, networkId: string | undefined, timeout: ReturnType<typeof setTimeout> | undefined;
		let finish!: () => void;
		const accepted = new Promise<void>(resolve => { finish = resolve; });
		const unlisten = browser.onEvent(event => {
			if (event.method === "Fetch.requestPaused") {
				void (async () => {
					const request = event.params.request, body = JSON.parse(request.postData ?? "{}");
					const attachments = body.content?.attachments ?? [], expected = input.remoteFiles ?? [];
					if (new URL(request.url).origin !== "https://chatgpt.com" || new URL(request.url).pathname !== `/backend-api/messaging/rooms/${room}/messages` || body.content?.text !== input.text
						|| !Array.isArray(attachments) || attachments.length !== expected.length
						|| !attachments.every((file: any) => file.type === "file" && expected.includes(file.file_id))
						|| new Set(attachments.map((file: any) => file.file_id)).size !== expected.length
						|| typeof body.request_id !== "string" || !uuid(body.request_id) || body.idempotency_token !== body.request_id) {
						await browser.call("Fetch.failRequest", { requestId: event.params.requestId, errorReason: "Aborted" });
						input.state = "not-sent"; input.error = "The browser selected a different Dot or message. Nothing was sent.";
						this.publish(input); finish(); return;
					}
					input.requestId = body.request_id; this.publish(input);
					await browser.call("Fetch.continueRequest", { requestId: event.params.requestId });
				})().catch(async () => {
					await browser.call("Fetch.failRequest", { requestId: event.params.requestId, errorReason: "Aborted" }).catch(() => {});
					finish();
				});
			} else if (event.method === "Network.requestWillBeSent") {
				const request = event.params.request;
				if (request.method !== "POST" || new URL(request.url).pathname !== `/backend-api/messaging/rooms/${room}/messages`) return;
				const body = JSON.parse(request.postData ?? "{}");
				if (body.content?.text !== input.text) return;
				networkId = event.params.requestId; input.requestId = body.request_id; this.publish(input);
			} else if (event.method === "Network.loadingFinished" && event.params.requestId === networkId) {
				void browser.call("Network.getResponseBody", { requestId: networkId }).then(result => {
					const response = JSON.parse(result.base64Encoded ? Buffer.from(result.body, "base64").toString() : result.body);
					if (typeof response.id === "string") { input.state = "accepted"; input.messageId = response.id; this.dirty = true; }
					else { input.state = "unknown"; input.error = "ChatGPT did not confirm delivery. Review its Dot page before trying again."; }
					this.publish(input); finish();
				}).catch(() => finish());
			} else if (event.method === "closed") finish();
		});
		try {
			const native = await browser.snapshot();
			if (native.dot !== input.dot || native.room !== room) throw Error("The signed-in Dot changed. Reconnect before sending.");
			if (native.draft.trim() || native.uploads.length) throw Error("The native Dot already has a draft. Open the native conversation to review it before sending.");
			const remoteFiles: string[] = [];
			for (const file of this.files.forInput(input.dot, input.files ?? [])) {
				this.files.save({ ...file, state: "uploading" });
				try {
					const remoteId = await browser.attach(file, this.files.path(file.id));
					this.files.save({ ...file, state: "uploaded", remoteId }); remoteFiles.push(remoteId);
				} catch (error) {
					this.files.save({ ...file, state: "unknown", error: String(error) }); throw error;
				}
			}
			input.remoteFiles = remoteFiles; this.publish(input);
			await browser.call("Fetch.enable", { patterns: [{ urlPattern: "https://chatgpt.com/backend-api/messaging/rooms/*/messages", requestStage: "Request" }] });
			await browser.prepare(input.text);
			// Once the click is attempted, a lost CDP result is an uncertain outcome.
			clicked = true;
			if (!await browser.submit(input.text)) { clicked = false; throw Error("Dot's send control is unavailable. Review its draft in ChatGPT."); }
			timeout = setTimeout(finish, 25_000); await accepted;
			if (input.state === "sending") { input.state = "unknown"; input.error = "Delivery is unconfirmed. Check Dot before sending again."; this.publish(input); }
		} catch (error) {
			input.state = clicked || input.requestId ? "unknown" : "not-sent";
			input.error = error instanceof Error ? error.message : String(error); this.publish(input);
		} finally {
			clearTimeout(timeout); unlisten(); await browser.call("Fetch.disable").catch(() => {});
			if (input.state === "accepted") for (const file of input.files ?? []) this.files.remove(file);
		}
	}
	private ready(dot?: string): DotBrowser {
		if (this.connecting || !this.browser || this.snapshot.state !== "ready" || dot && dot !== this.snapshot.id) throw Error("Dot changed or disconnected. Reconnect before continuing.");
		return this.browser;
	}
	stageFile(id: string, dot: string, name: string, mime: string, size: number): DotUpload {
		this.ready(dot); return this.files.create(id, dot, name, mime, size);
	}
	appendFile(id: string, offset: number, data: string): DotUpload {
		const file = this.files.get(id); this.ready(file?.dot);
		return this.files.append(id, offset, data);
	}
	removeFile(id: string): void {
		if (this.sending) throw Error("Wait for the current message receipt.");
		const file = this.files.get(id); this.ready(file?.dot); this.files.remove(id);
	}
	openSurface(mode: DotSurfaceMode): Promise<DotSurfaceFrame> {
		if (this.busy) throw Error("Wait for the current Dot operation.");
		const job = this.createSurface(mode).finally(() => { if (this.browsing === job) this.browsing = undefined; });
		this.browsing = job; return job;
	}
	private async createSurface(mode: DotSurfaceMode): Promise<DotSurfaceFrame> {
		if (!["conversation", "activity", "settings", "computer"].includes(mode)) throw Error("Unsupported native view.");
		if (this.sending) throw Error("Wait for the current message receipt.");
		const main = this.ready(); await this.clearSurface();
		const owned = mode !== "conversation", browser = owned ? new DotBrowser(this.agentDir) : main;
		try {
			if (owned) {
				await browser.open(this.config.path);
				const native = await browser.select();
				if (native.dot !== this.snapshot.id) throw Error("The native Dot changed.");
			}
			const surface = this.surface = new DotSurface(browser, owned, this.snapshot.id!, mode);
			await surface.open(); return surface.view();
		} catch (error) { await this.clearSurface(); if (owned) await browser.close(); throw error; }
	}
	surfaceView(id: string, after?: number) { return this.currentSurface(id).view(after); }
	surfaceInput(id: string, event: string, width: number, height: number, input: DotSurfaceInput) {
		if (this.sending || this.connecting || this.browsing || this.handingOff) throw Error("Wait for the current Dot operation.");
		return this.currentSurface(id).input(event, width, height, input);
	}
	private currentSurface(id: string): DotSurface {
		if (!this.surface || this.surface.id !== id) throw Error("The native view changed. Open it again.");
		return this.surface;
	}
	async surfaceFiles(id: string, files: string[]): Promise<void> {
		if (this.busy) throw Error("Wait for the current Dot operation.");
		const surface = this.currentSurface(id), selected = this.files.forInput(this.snapshot.id!, files);
		const job = (async () => {
			for (const file of selected) { this.files.save({ ...file, state: "uploading" }); this.handoffs.add(file.id); }
			try {
				await surface.chooseFiles(selected.map(file => this.files.path(file.id)));
				for (const file of selected) this.files.save({ ...file, state: "handed-off" });
			} catch (error) {
				for (const file of selected) this.files.save({ ...file, state: "unknown", error: "Native upload is unconfirmed. Review Dot before uploading again." });
				throw error;
			}
		})().finally(() => { if (this.handingOff === job) this.handingOff = undefined; });
		this.handingOff = job; return job;
	}
	async closeSurface(id?: string): Promise<void> {
		await this.browsing?.catch(() => {}); await this.handingOff?.catch(() => {}); await this.clearSurface(id);
	}
	private async clearSurface(id?: string): Promise<void> {
		await this.clearingSurface;
		if (id && id !== this.surface?.id) return;
		const surface = this.surface; this.surface = undefined;
		const job = (async () => {
			await surface?.close();
			for (const id of this.handoffs) {
				const file = this.files.get(id);
				if (file) this.files.save({ ...file, state: "unknown", error: "The native view closed without an upload receipt. Review Dot before uploading again." });
			}
			this.handoffs.clear(); this.dirty = true;
		})().finally(() => { if (this.clearingSurface === job) this.clearingSurface = undefined; });
		this.clearingSurface = job; await job;
	}
	async download(message: string, attachment: string) {
		if (this.sending) throw Error("Wait for the current message receipt.");
		return this.ready().download(message, attachment);
	}
	downloadChunk(id: string, offset: number, surface?: string) {
		if (!uuid(id) || !Number.isSafeInteger(offset) || offset < 0) throw Error("Invalid native download.");
		return surface ? this.currentSurface(surface).downloadChunk(id, offset) : this.ready().downloadChunk(id, offset);
	}
	async releaseDownload(id: string, surface?: string): Promise<void> {
		if (!uuid(id)) throw Error("Invalid native download.");
		if (surface) await this.currentSurface(surface).releaseDownload(id); else await this.ready().releaseDownload(id);
	}
	async disconnect(): Promise<void> {
		if (this.busy) throw Error("Wait for the current Dot operation before disconnecting.");
		this.config = { enabled: false }; atomicJson(join(this.directory, "connection.json"), this.config);
		await this.close(); this.snapshot = { state: "disconnected", messages: [], inputs: this.snapshot.inputs };
	}
	async close(): Promise<void> {
		this.stopped = true; await this.connecting?.catch(() => {}); await this.sending; await this.refreshing;
		await this.closeSurface();
		await this.browser?.close(); this.browser = undefined;
	}
}
