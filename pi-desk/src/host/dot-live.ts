import type WebSocket from "ws";
import { DotHttpError, type DotHttp } from "./dot-http.ts";
import { dotObject, dotString, type DotRoom } from "./dot-wire.ts";

const TOPIC = "calpico-chatgpt-messaging";
export type DotLiveEvent =
	| { type: "connection"; connected: boolean; error?: string }
	| { type: "refresh"; metadata: boolean }
	| { type: "receipt"; request: string; message: string };

/** A background subscription does not mark rooms read or generate typing/agent activity. */
export class DotLive {
	private http: Pick<DotHttp, "json" | "socket">;
	private room: DotRoom;
	private changed: (event: DotLiveEvent) => void;
	private abort = new AbortController();
	private socket?: WebSocket;
	private retry?: ReturnType<typeof setTimeout>;
	private deadline?: ReturnType<typeof setTimeout>;
	private attempts = 0;
	private offset?: string;
	private typing = new Map<string, number>();
	private started = false;
	connected = false;
	constructor(http: Pick<DotHttp, "json" | "socket">, room: DotRoom, changed: (event: DotLiveEvent) => void) {
		this.http = http; this.room = room; this.changed = changed;
	}
	get writing(): boolean {
		const now = Date.now();
		for (const [member, until] of this.typing) if (until <= now) this.typing.delete(member);
		return this.typing.size > 0;
	}
	updateRoom(room: DotRoom): void {
		if (room.id !== this.room.id || room.dot !== this.room.dot) throw Error("Dot's live room changed.");
		this.room = room;
	}
	start(): void { if (!this.started) { this.started = true; void this.open(); } }
	private async open(): Promise<void> {
		if (this.abort.signal.aborted) return;
		try {
			const response = await this.http.json<unknown>("GET", "/celsius/ws/user", { signal: this.abort.signal });
			if (this.abort.signal.aborted) return;
			const socket = this.socket = this.http.socket(dotString(dotObject(response).websocket_url, "live-update URL", 16_384));
			socket.on("error", () => { if (this.socket === socket) socket.close(); });
			socket.once("open", () => {
				if (this.socket !== socket || this.abort.signal.aborted) return;
				socket.send(JSON.stringify([
					{ id: 1, command: { type: "connect", presence: { type: "presence", state: "background" } } },
					{ id: 2, command: { type: "subscribe", topic_id: TOPIC, ...(this.offset ? { offset: this.offset } : {}) } },
				]));
			});
			socket.on("message", data => {
				if (this.socket !== socket || this.abort.signal.aborted) return;
				let rows: unknown; try { rows = JSON.parse(data.toString()); } catch { return; }
				if (!Array.isArray(rows)) return;
				for (const value of rows) {
					const row = dotObject(value), reply = dotObject(row.reply);
					if (row.id === 2 && reply.type === "subscribe" && reply.topic_id === TOPIC && typeof reply.recovered === "boolean") {
						clearTimeout(this.deadline); this.deadline = undefined; this.attempts = 0; this.connected = true;
						if (reply.recovered && Array.isArray(reply.catchups)) for (const event of reply.catchups) this.message(event);
						if (typeof reply.last_offset === "string") this.offset = reply.last_offset;
						this.changed({ type: "connection", connected: true });
						// Full resync also covers unrecovered offsets and messages arriving during initial reads.
						this.changed({ type: "refresh", metadata: true });
					} else this.message(row);
				}
			});
			socket.once("close", () => { if (this.socket === socket) { this.socket = undefined; this.disconnected(); } });
			this.deadline = setTimeout(() => { if (this.socket === socket) socket.terminate(); }, 15_000);
			this.deadline.unref();
		} catch (error) {
			if (this.abort.signal.aborted) return;
			if (error instanceof DotHttpError && (error.status === 401 || error.status === 403)) {
				this.changed({ type: "connection", connected: false, error: error.message }); return;
			}
			this.disconnected();
		}
	}
	private message(value: unknown): void {
		const row = dotObject(value);
		if (row.type !== "message" || row.topic_id !== TOPIC) return;
		if (typeof row.offset === "string") this.offset = row.offset;
		const event = dotObject(row.payload), payload = dotObject(event.payload);
		const id = event.type === "calpico-room-update" ? dotObject(payload.room).id : payload.room_id;
		if (id !== this.room.id) return;
		if (event.type === "calpico-is-responding-heartbeat") {
			const member = dotObject(payload.source).account_user_id;
			if (typeof member !== "string" || !this.room.members.some(item => item.id === member && item.dot === this.room.dot)) return;
			if (payload.typing === false) this.typing.delete(member); else this.typing.set(member, Date.now() + 15_000);
			return;
		}
		if (event.type === "calpico-message-add") {
			const message = dotObject(payload.message);
			if (typeof message.request_id === "string" && typeof message.id === "string")
				this.changed({ type: "receipt", request: message.request_id, message: message.id });
			this.changed({ type: "refresh", metadata: false });
		} else if (event.type === "calpico-message-update") this.changed({ type: "refresh", metadata: false });
		else if (["calpico-room-update", "calpico-room-metadata-update", "calpico-room-leave"].includes(String(event.type)))
			this.changed({ type: "refresh", metadata: true });
	}
	private disconnected(): void {
		clearTimeout(this.deadline); this.deadline = undefined; this.connected = false; this.typing.clear();
		if (this.abort.signal.aborted) return;
		this.changed({ type: "connection", connected: false });
		clearTimeout(this.retry);
		const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.attempts++, 5)) * (0.8 + Math.random() * 0.4);
		this.retry = setTimeout(() => { this.retry = undefined; void this.open(); }, delay); this.retry.unref();
	}
	close(): void {
		this.abort.abort(); clearTimeout(this.retry); clearTimeout(this.deadline); this.typing.clear(); this.connected = false;
		const socket = this.socket; this.socket = undefined; socket?.close();
	}
}
