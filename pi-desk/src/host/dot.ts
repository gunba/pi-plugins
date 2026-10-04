import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { atomicJson } from "../../manage/store.ts";
import type { DotInput, DotMessage, DotSnapshot } from "../shared/dot.ts";
import { DotBrowser } from "./dot-browser.ts";

interface Member { account_user_id: string; aeon_id?: string; name?: string }
interface RemoteMessage {
	id: string; account_user_id?: string; content?: { text?: string; attachments?: { name?: string }[] };
	created_at: string; deleted_at?: string | null; request_id?: string;
}
export function dotMessages(items: RemoteMessage[], members: Member[], dot: string): DotMessage[] {
	const dotMember = members.find(member => member.aeon_id === dot);
	return items.filter(message => !message.deleted_at).map(message => {
		const member = members.find(member => member.account_user_id === message.account_user_id);
		return { id: message.id, author: member && member === dotMember ? "dot" : member && !member.aeon_id ? "owner" : "other",
			name: member?.name, text: typeof message.content?.text === "string" ? message.content.text : "",
			created: message.created_at, attachments: (message.content?.attachments ?? []).flatMap(file => file.name ? [file.name] : []) };
	});
}
interface Config { enabled: boolean; dot?: string }
const uuid = (id: string) => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id);

export class DotConnection {
	private browser?: DotBrowser;
	private config: Config;
	private snapshot: DotSnapshot = { state: "disconnected", messages: [], inputs: [] };
	private directory: string;
	private refreshing?: Promise<void>;
	private connecting?: Promise<void>;
	private sending?: Promise<void>;
	private room?: string;
	private dirty = true;
	private fetched = 0;
	private stopped = false;
	private members: Member[] = [];

	private agentDir: string;
	constructor(dataDir: string, agentDir: string) {
		this.agentDir = agentDir;
		this.directory = join(dataDir, "dot");
		mkdirSync(this.directory, { recursive: true, mode: 0o700 });
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
		if (this.sending) throw Error("Wait for the Dot message receipt before reconnecting.");
		this.stopped = false;
		const job = this.open(explicit).finally(() => { if (this.connecting === job) this.connecting = undefined; });
		this.connecting = job; return job;
	}
	private async open(explicit: boolean): Promise<void> {
		await this.browser?.close();
		this.snapshot = { state: "connecting", messages: [], inputs: this.snapshot.inputs };
		const browser = this.browser = new DotBrowser(this.agentDir);
		try {
			await browser.open();
			const { profile } = await browser.read("/tbo/primary");
			if (!profile?.id || !profile.messaging_room_id) throw Error("Create a Dot in this ChatGPT account before connecting.");
			if (!explicit && this.config.dot !== profile.id) throw Error("The signed-in Dot changed. Reconnect to choose it.");
			await browser.select(profile.display_name);
			const room = await browser.read("/messaging/rooms/{room_id}", { path: { room_id: profile.messaging_room_id } });
			this.members = room.members;
			if (!this.members.some(member => member.aeon_id === profile.id)) throw Error("Dot's messaging identity is unavailable.");
			this.room = profile.messaging_room_id;
			this.snapshot = { ...this.snapshot, state: "ready", id: profile.id, name: profile.display_name, paused: profile.is_paused };
			this.config = { enabled: true, dot: profile.id }; atomicJson(join(this.directory, "connection.json"), this.config);
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
			const result = await browser.read("/messaging/rooms/{room_id}/messages", { path: { room_id: room }, query: { limit: 32 } });
			if (browser !== this.browser || this.stopped) return;
			this.snapshot.messages = dotMessages(result.items, this.members, dot);
			this.snapshot.before = result.prev_cursor ?? undefined; this.fetched = Date.now();
			for (const input of this.snapshot.inputs.filter(input => input.dot === dot && input.state === "unknown" && input.requestId)) {
				const found: RemoteMessage | undefined = result.items.find((item: RemoteMessage) => item.request_id === input.requestId);
				if (found) this.publish({ ...input, state: "accepted", messageId: found.id, error: undefined });
			}
		})().catch(error => {
			this.snapshot = { ...this.snapshot, state: "unavailable", error: error instanceof Error ? error.message : String(error) };
		}).finally(() => { if (this.refreshing === job) this.refreshing = undefined; });
		this.refreshing = job; return job;
	}
	async view(): Promise<DotSnapshot> {
		if (this.dirty || Date.now() - this.fetched > 30_000) await this.refresh();
		return structuredClone(this.snapshot);
	}
	async history(before: string): Promise<{ messages: DotMessage[]; before?: string }> {
		if (this.snapshot.state !== "ready" || !this.room) throw Error("Reconnect Dot before loading history.");
		const result = await this.browser!.read("/messaging/rooms/{room_id}/messages", {
			path: { room_id: this.room }, query: { before, limit: 32 },
		});
		return { messages: dotMessages(result.items, this.members, this.snapshot.id!), before: result.prev_cursor ?? undefined };
	}
	send(id: string, dot: string, text: string): DotInput {
		if (!uuid(id) || !text.trim() || text.length > 32_000) throw Error("Enter a Dot message of at most 32,000 characters.");
		const previous = this.input(id);
		if (previous) { if (previous.dot !== dot || previous.text !== text) throw Error("Dot message receipt was reused for different input."); return previous; }
		if (this.snapshot.state !== "ready" || this.snapshot.id !== dot) throw Error("Dot changed or disconnected. Reconnect before sending.");
		if (this.sending) throw Error("Wait for the current Dot message receipt.");
		const input: DotInput = { id, dot, text, created: new Date().toISOString(), state: "sending" };
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
					if (new URL(request.url).pathname !== `/backend-api/messaging/rooms/${room}/messages` || body.content?.text !== input.text
						|| typeof body.request_id !== "string" || !uuid(body.request_id)) {
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
			const { profile } = await browser.read("/tbo/primary");
			if (profile?.id !== input.dot || profile.messaging_room_id !== room) throw Error("The signed-in Dot changed. Reconnect before sending.");
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
		} finally { clearTimeout(timeout); unlisten(); await browser.call("Fetch.disable").catch(() => {}); }
	}
	async disconnect(): Promise<void> {
		if (this.sending) throw Error("Wait for the Dot message receipt before disconnecting.");
		this.config = { enabled: false }; atomicJson(join(this.directory, "connection.json"), this.config);
		await this.close(); this.snapshot = { state: "disconnected", messages: [], inputs: this.snapshot.inputs };
	}
	async close(): Promise<void> {
		this.stopped = true; await this.connecting?.catch(() => {}); await this.sending; await this.refreshing;
		await this.browser?.close(); this.browser = undefined;
	}
}
