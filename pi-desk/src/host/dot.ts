import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicJson } from "../../manage/store.ts";
import { DotAuth, DotAuthError, type DotAuthorize, type DotIdentity } from "./dot-auth.ts";
import { DotApi, type DotApiEvent, type DotRead } from "./dot-api.ts";
import { DotHttpError } from "./dot-http.ts";
import { DotFiles, dotUuid } from "./dot-files.ts";
import { DotDownloadStore } from "./dot-download-store.ts";
import type { DotEntry } from "./dot-wire.ts";
import type { DotSnapshot, DotInput, DotUpload, DotDownload } from "../shared/dot.ts";

interface Config {
	enabled: boolean; dot?: string; name?: string; path?: string; room?: string;
	identity?: DotIdentity; connection?: string;
}
type Client = Pick<DotApi, "open" | "read" | "history" | "send" | "attach" | "download" | "close" | "identity" | "connected" | "writing" | "avatarView">;
interface Options {
	/** Pi's auth.json: Dot uses Pi's own ChatGPT (Codex) login. */
	authPath: string;
	proxy?: string;
	client?: (authorize: DotAuthorize, changed: (event: DotApiEvent) => void) => Client;
}
const rejected = (error: unknown) => error instanceof DotHttpError && [400, 401, 403, 404, 413, 415, 422, 429].includes(error.status);
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Chat with Jordan's Dot through Pi's ChatGPT login. */
export class DotConnection {
	private directory: string;
	private options: Options;
	private config: Config = { enabled: false };
	private loadFailed = false;
	private snapshot: DotSnapshot = { transport: "direct", state: "disconnected", messages: [], inputs: [] };
	private client?: Client;
	private candidate?: Client;
	private connecting?: Promise<void>;
	private work?: Promise<void>;
	private refreshing?: Promise<void>;
	private revision = 1;
	private seen = 0;
	private metadataRevision = 1;
	private fetched = 0;
	private retryAt = 0;
	private failures = 0;
	private fatal = false;
	private stopped = false;
	private inputs = new Map<string, DotInput>();
	private files: DotFiles;
	private downloads: DotDownloadStore;
	get busy(): boolean { return !!this.work || !!this.connecting; }
	constructor(dataDir: string, options: Options) {
		this.directory = join(dataDir, "dot"); this.options = options;
		mkdirSync(this.directory, { recursive: true, mode: 0o700 });
		this.files = new DotFiles(this.directory); this.downloads = new DotDownloadStore(this.directory);
		try {
			this.config = this.read<Config>(join(this.directory, "connection.json")) ?? { enabled: false };
			if (typeof this.config.enabled !== "boolean") throw Error("Invalid Dot connection settings.");
			for (const file of readdirSync(this.directory).filter(name => /^[a-f0-9-]{36}\.json$/.test(name))) {
				const input = this.read<DotInput>(join(this.directory, file));
				if (input) {
					if (!dotUuid(input.id) || file !== `${input.id}.json`) throw Error("Invalid Dot receipt.");
					if (input.state === "sending") this.save({ ...input, state: "unknown", error: "Desk stopped before delivery was confirmed. Check Dot before trying again." });
					else this.inputs.set(input.id, input);
				}
			}
		} catch {
			this.loadFailed = true; this.snapshot = { ...this.snapshot, state: "unavailable", error: "Dot’s saved connection or delivery receipts could not be read. Restore them before reconnecting; no messages have been retried." };
		}
	}
	private read<T>(path: string): T | undefined {
		try { return JSON.parse(readFileSync(path, "utf8")); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	}
	private save(input: DotInput): void {
		if (this.loadFailed) throw Error("Dot’s saved delivery state could not be read.");
		atomicJson(join(this.directory, `${input.id}.json`), input); this.inputs.set(input.id, structuredClone(input));
		if (input.state === "accepted") for (const id of input.files ?? []) {
			// A failed cache cleanup must not invalidate a durable delivery receipt.
			try { this.files.remove(id); } catch {}
		}
	}
	private receipts(): DotInput[] { return [...this.inputs.values()].sort((a, b) => b.created.localeCompare(a.created)).slice(0, 15); }
	start(): void { if (this.config.enabled) void this.reconnect(true).catch(() => {}); }
	/** Connecting by hand accepts whichever ChatGPT account Pi is signed into; reconnecting by itself keeps the same one. */
	connect(): Promise<void> { return this.reconnect(false); }
	private reconnect(automatic: boolean): Promise<void> {
		if (this.loadFailed) return Promise.reject(Error("Dot’s saved connection or delivery receipts could not be read."));
		if (this.connecting) return Promise.reject(Error("Wait for Dot's current connection attempt."));
		if (this.busy) return Promise.reject(Error("Finish the Dot message before reconnecting."));
		this.stopped = false;
		this.connecting = this.open(automatic).finally(() => { this.connecting = undefined; });
		return this.connecting;
	}
	private async open(automatic: boolean): Promise<void> {
		const previous = this.client;
		this.snapshot = { ...this.snapshot, state: "connecting", error: undefined };
		let candidate: Client | undefined;
		try {
			const auth = new DotAuth(this.options.authPath, automatic ? this.config.identity : undefined);
			const changed = (event: DotApiEvent) => { if (this.client === candidate && !this.stopped) this.changed(event); };
			candidate = this.options.client?.(auth.authorize, changed) ?? new DotApi(auth.authorize, changed, this.options.proxy);
			this.candidate = candidate;
			const initial = await candidate.open(this.config.dot ? { dot: this.config.dot, path: this.config.path, room: this.config.room } : {});
			if (this.stopped) return;
			const identity = candidate.identity;
			if (!identity) throw Error("Dot did not confirm its account.");
			const connection = createHash("sha256").update(JSON.stringify([identity.accountId, identity.userId, initial.dot, initial.room])).digest("hex");
			const config: Config = { enabled: true, identity, connection,
				dot: initial.dot, name: initial.name, path: initial.path, room: initial.room };
			await this.downloads.clear();
			if (this.stopped) return;
			atomicJson(join(this.directory, "connection.json"), config);
			this.config = config; this.client = candidate; previous?.close();
			this.fatal = false; this.retryAt = 0; this.failures = 0;
			this.apply(initial); this.metadataRevision = ++this.revision;
		} catch (error) {
			if (!this.stopped) {
				if (candidate && this.client === candidate) {
					this.snapshot = { transport: "direct", state: "unavailable", id: this.config.dot, name: this.config.name, messages: [], inputs: this.receipts() }; this.storageFailure();
				} else this.snapshot = { ...this.snapshot, state: previous && !this.fatal ? "ready" : "unavailable", error: message(error) };
			}
			throw error;
		} finally {
			if (candidate !== this.client) candidate?.close();
			this.candidate = undefined;
		}
	}
	private changed(event: DotApiEvent): void {
		try {
			if (event.type === "receipt") {
				const input = [...this.inputs.values()].find(item => item.requestId === event.request && item.dot === this.config.dot
					&& item.connection === this.config.connection && ["sending", "unknown"].includes(item.state));
				if (input) this.save({ ...input, state: "accepted", messageId: event.message, error: undefined });
			}
			if (event.type === "avatar") return;
			this.revision++;
			if (event.type === "refresh" && event.metadata) this.metadataRevision = this.revision;
		} catch { this.storageFailure(); }
	}
	private storageFailure(): void {
		this.fatal = true; this.snapshot = { ...this.snapshot, state: "unavailable", error: "Dot's delivery receipt could not be saved. Check disk space and reconnect before sending again." };
	}
	private reconcile(entries: DotEntry[]): void {
		for (const input of this.inputs.values()) {
			if (input.dot !== this.config.dot || input.connection && input.connection !== this.config.connection || !["unknown", "sending"].includes(input.state) || !input.requestId) continue;
			const found = entries.find(entry => entry.requestId === input.requestId && entry.message.author === "owner" && entry.message.text === input.text
				&& JSON.stringify(entry.files.map(file => file.file).sort()) === JSON.stringify([...(input.remoteFiles ?? [])].sort()));
			if (found) this.save({ ...input, state: "accepted", messageId: found.message.id, error: undefined });
		}
	}
	private apply(read: DotRead): void {
		if (read.dot !== this.config.dot || read.room !== this.config.room) throw Error("The connected Dot changed. Reconnect before continuing.");
		this.reconcile(read.entries);
		this.snapshot = { transport: "direct", state: "ready", id: read.dot, name: read.name, paused: read.paused,
			messages: read.entries.map(entry => entry.message), before: read.before, inputs: this.receipts(), ...this.client?.avatarView };
		if (this.config.path !== read.path || this.config.name !== read.name) {
			const config = { ...this.config, path: read.path, name: read.name };
			atomicJson(join(this.directory, "connection.json"), config); this.config = config;
		}
	}
	private async refresh(): Promise<void> {
		if (this.refreshing) return this.refreshing;
		const client = this.client; if (!client || this.stopped || this.fatal || this.connecting) return;
		const revision = this.revision;
		this.refreshing = (async () => {
			try {
				const read = await client.read(this.metadataRevision > this.seen);
				if (client !== this.client || this.stopped || this.connecting) return;
				this.apply(read); this.seen = revision; this.failures = 0; this.retryAt = 0; this.fetched = Date.now();
			} catch (error) {
				if (client !== this.client || this.stopped) return;
				this.fatal = error instanceof DotAuthError || error instanceof DotHttpError && [401, 403, 404].includes(error.status);
				this.retryAt = Date.now() + Math.min(30_000, 2000 * 2 ** Math.min(this.failures++, 4));
				this.snapshot = { ...this.snapshot, state: "unavailable", error: message(error) };
			}
		})().finally(() => { this.refreshing = undefined; });
		return this.refreshing;
	}
	async view(): Promise<DotSnapshot> {
		if (!this.stopped && this.client && !this.fatal && Date.now() >= this.retryAt
			&& (this.revision !== this.seen || Date.now() - this.fetched > (this.client.connected ? 30_000 : 5000))) await this.refresh();
		return structuredClone({ ...this.snapshot, transport: "direct", busy: this.busy,
			id: this.snapshot.id ?? this.config.dot, name: this.snapshot.name ?? this.config.name,
			identity: this.config.identity?.email, connection: this.config.connection,
			live: this.client?.connected ?? false, writing: this.client?.writing ?? false, ...this.client?.avatarView,
			inputs: this.receipts(), uploads: this.files.list(this.snapshot.id ?? this.config.dot) });
	}
	async history(before: string): Promise<{ messages: DotSnapshot["messages"]; before?: string }> {
		const client = this.ready(), page = await client.history(before);
		if (client !== this.client) throw Error("Dot connection changed.");
		this.reconcile(page.entries); return { messages: page.entries.map(entry => entry.message), before: page.before };
	}
	private ready(): Client {
		if (!this.client || this.stopped || this.connecting || this.snapshot.state !== "ready") throw Error("Reconnect Dot before continuing.");
		return this.client;
	}
	private binding(connection: string): void {
		if (!/^[a-f0-9]{64}$/.test(connection) || connection !== this.config.connection) throw Error("Dot's account or conversation changed. Review this message before sending it.");
	}
	send(id: string, dot: string, text: string, files: string[], connection: string): DotInput {
		this.validateIntent(id, dot, text, files);
		const previous = this.inputs.get(id);
		if (previous) { this.sameIntent(previous, dot, text, files, connection); return structuredClone(previous); }
		this.binding(connection); this.ready();
		if (this.busy) throw Error("Wait for the current Dot action.");
		if (dot !== this.snapshot.id) throw Error("The selected Dot changed. Review it before sending.");
		this.files.forInput(dot, files, connection);
		if (files.some(file => [...this.inputs.values()].some(input => ["sending", "accepted", "unknown"].includes(input.state) && input.files?.includes(file)))) throw Error("An attachment is already reserved by an earlier message. Check that message before reusing it.");
		if (!text.trim() && !files.length) throw Error("Add a message or attachment.");
		const input: DotInput = { id, dot, text, files, connection, created: new Date().toISOString(), state: "sending" };
		this.save(input); this.work = this.deliver(input).finally(() => { this.work = undefined; });
		return structuredClone(input);
	}
	/** Whether Desk can post its own notice in the Dot conversation. */
	get canNotify(): boolean { return !!this.client && !this.stopped && !this.connecting && this.snapshot.state === "ready" && !!this.snapshot.id && !!this.config.connection; }
	/** Post Desk's own notice in the Dot conversation, as Jordan's account; false when it cannot be sent now. */
	notify(text: string): boolean {
		if (!this.canNotify || this.busy) return false;
		try { this.send(randomUUID(), this.snapshot.id!, text, [], this.config.connection!); return true; } catch { return false; }
	}
	private validateIntent(id: string, dot: string, text: string, files: string[]): void {
		if (!dotUuid(id) || typeof dot !== "string" || !dot || dot.length > 200 || typeof text !== "string" || text.length > 32_000
			|| !Array.isArray(files) || files.length > 8 || new Set(files).size !== files.length || files.some(file => !dotUuid(file))
			|| !text.trim() && !files.length) throw Error("Invalid Dot input or attachments.");
	}
	private sameIntent(previous: DotInput, dot: string, text: string, files: string[], connection?: string): void {
		if (previous.dot !== dot || previous.text !== text || previous.connection !== connection || JSON.stringify(previous.files ?? []) !== JSON.stringify(files))
			throw Error("Dot input ID was reused with different input or account.");
	}
	cancelInput(id: string, dot: string, text: string, files: string[] = [], connection?: string): DotInput {
		this.validateIntent(id, dot, text, files);
		const previous = this.inputs.get(id);
		if (previous) { this.sameIntent(previous, dot, text, files, connection); return structuredClone(previous); }
		const cancelled: DotInput = { id, dot, text, files, ...(connection ? { connection } : {}), created: new Date().toISOString(), state: "not-sent", error: "Cancelled before Desk accepted this message." };
		this.save(cancelled); return structuredClone(cancelled);
	}
	async input(id: string): Promise<DotInput | undefined> {
		if (this.inputs.get(id)?.state === "unknown") { this.revision++; await this.refresh(); }
		return structuredClone(this.inputs.get(id));
	}
	private async deliver(input: DotInput): Promise<void> {
		let dispatched = false;
		try {
			const client = this.ready(), remoteFiles: string[] = [];
			for (const file of this.files.forInput(input.dot, input.files ?? [], input.connection)) {
				if (file.state === "uploaded" && file.remoteId) { remoteFiles.push(file.remoteId); continue; }
				let uploading = false;
				try {
					const remoteId = await client.attach(file, this.files.path(file.id), () => {
						this.files.save({ ...file, state: "uploading", error: undefined }); uploading = true;
					});
					this.files.save({ ...file, state: "uploaded", remoteId, error: undefined }); remoteFiles.push(remoteId);
				} catch (error) {
					this.files.save({ ...file, state: uploading && !rejected(error) ? "unknown" : "ready", error: message(error) }); throw error;
				}
			}
			input.remoteFiles = remoteFiles;
			const sent = await client.send(input.id, input.text, remoteFiles, () => {
				input.requestId = input.id; this.save(input); dispatched = true;
			});
			this.save({ ...input, state: "accepted", messageId: sent.message.id, error: undefined });
		} catch (error) {
			if (this.inputs.get(input.id)?.state !== "accepted") {
				try { this.save({ ...input, state: !dispatched || rejected(error) ? "not-sent" : "unknown", error: message(error) }); }
				catch { this.storageFailure(); }
			}
		} finally { this.revision++; }
	}
	stageFile(id: string, dot: string, name: string, mime: string, size: number, connection: string): DotUpload {
		this.ready(); this.binding(connection); if (dot !== this.snapshot.id) throw Error("The selected Dot changed.");
		return this.files.create(id, dot, name, mime, size, connection);
	}
	appendFile(id: string, offset: number, data: string): DotUpload {
		this.ready(); const file = this.files.get(id); if (!file || file.dot !== this.snapshot.id) throw Error("The selected Dot changed.");
		this.binding(file.connection ?? ""); return this.files.append(id, offset, data);
	}
	removeFile(id: string): void {
		if (this.work) throw Error("Wait for the current Dot action.");
		this.files.remove(id);
	}
	download(message: string, attachment: string): Promise<DotDownload> {
		const client = this.ready();
		return this.downloads.create((path, maximum, signal) => client.download(message, attachment, path, maximum, signal));
	}
	downloadChunk(id: string, offset: number): Promise<{ data: string; next: number; size: number }> { return this.downloads.chunk(id, offset); }
	releaseDownload(id: string): Promise<void> { return this.downloads.release(id); }
	async disconnect(): Promise<void> {
		if (this.busy) throw Error("Finish the current Dot action before disconnecting.");
		await this.close(); this.config = { ...this.config, enabled: false }; atomicJson(join(this.directory, "connection.json"), this.config);
		this.snapshot = { transport: "direct", state: "disconnected", id: this.config.dot, name: this.config.name, messages: [], inputs: this.receipts() };
	}
	async close(): Promise<void> {
		this.stopped = true; this.candidate?.close();
		await this.work; await this.connecting?.catch(() => {});
		const client = this.client; this.client = undefined; client?.close(); await this.downloads.clear();
	}
}
