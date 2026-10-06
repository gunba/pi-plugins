import { DotHttp } from "./dot-http.ts";
import { DotAvatar } from "./dot-avatar.ts";
import type { DotUpload } from "../shared/dot.ts";
import type { DotAuthorize, DotIdentity } from "./dot-auth.ts";
import { DotLive, type DotLiveEvent } from "./dot-live.ts";
import { dotObject, dotString, dotProfile, dotRoom, dotPage, dotEntry, type DotProfile, type DotRoom, type DotPage, type DotEntry } from "./dot-wire.ts";

type Transport = Pick<DotHttp, "json" | "socket" | "close" | "asset" | "upload" | "download">;
export type DotApiEvent = DotLiveEvent | { type: "avatar" };
export interface DotPin { dot?: string; path?: string; room?: string }
export interface DotRead extends DotPage {
	dot: string; room: string; name: string; path: string; paused: boolean; avatar?: string; avatarError?: string;
}

/** REST owns data and delivery; the socket only invalidates caches and correlates receipts. */
export class DotApi {
	private http: Transport;
	private authorize: DotAuthorize;
	private abort = new AbortController();
	private profile?: DotProfile;
	private room?: DotRoom;
	private account?: DotIdentity;
	private live?: DotLive;
	private metadataAt = 0;
	private avatar = new DotAvatar(() => this.changed({ type: "avatar" }));
	private changed: (event: DotApiEvent) => void;
	constructor(authorize: DotAuthorize, changed: (event: DotApiEvent) => void, proxy?: string, transport?: Transport) {
		this.changed = changed;
		this.authorize = async signal => {
			const auth = await authorize(signal);
			if (this.account && (auth.identity.accountId !== this.account.accountId || auth.identity.userId !== this.account.userId))
				throw Error("Dot's account changed. Reconnect before continuing.");
			this.account = { ...auth.identity }; return auth;
		};
		this.http = transport ?? new DotHttp(this.authorize, proxy);
	}
	get avatarView(): { avatar?: string; avatarError?: string } { return { avatar: this.avatar.value, avatarError: this.avatar.error }; }
	get identity(): DotIdentity | undefined { return this.account && { ...this.account }; }
	get connected(): boolean { return this.live?.connected ?? false; }
	get writing(): boolean { return this.live?.writing ?? false; }
	async open(pin: DotPin = {}): Promise<DotRead> {
		await this.authorize(this.abort.signal);
		let value: unknown, thread: string | undefined;
		if (pin.path) {
			if (!/^\/dots\/[a-zA-Z0-9_~-]+$/.test(pin.path)) throw Error("Invalid saved Dot path.");
			thread = pin.path.slice(6);
			value = await this.get(`/tbo/by-thread/${encodeURIComponent(thread)}`);
		} else {
			const primary = dotObject(await this.get("/tbo/primary")), selection = dotObject(primary.selection);
			if (selection.available !== true) throw Error("This account has no available Dot. Choose the account that owns your Dot.");
			thread = dotString(selection.thread_id, "primary thread");
			value = primary.profile ?? await this.get(`/tbo/by-thread/${encodeURIComponent(thread)}`);
			const profile = dotProfile(value, thread);
			if (selection.aeon_id != null && selection.aeon_id !== profile.id || selection.messaging_room_id != null && selection.messaging_room_id !== profile.room)
				throw Error("Dot's primary selection changed. Reconnect before continuing.");
		}
		const profile = dotProfile(value, thread);
		if (pin.dot && pin.dot !== profile.id || pin.room && pin.room !== profile.room) throw Error("The saved Dot changed. Reconnect to choose it.");
		this.profile = profile;
		this.room = dotRoom(await this.get(`/messaging/rooms/${encodeURIComponent(profile.room)}`), profile);
		this.metadataAt = Date.now();
		const result = await this.read();
		this.live = new DotLive(this.http, this.room, this.changed); this.live.start();
		return result;
	}
	private get(path: string): Promise<unknown> { return this.http.json("GET", path, { signal: this.abort.signal }); }
	private ready(): { profile: DotProfile; room: DotRoom; identity: DotIdentity } {
		this.abort.signal.throwIfAborted();
		if (!this.profile || !this.room || !this.account) throw Error("Connect Dot before continuing.");
		return { profile: this.profile, room: this.room, identity: this.account };
	}
	async read(metadata = false): Promise<DotRead> {
		let current = this.ready();
		if (metadata || Date.now() - this.metadataAt > 30_000) {
			const profile = dotProfile(await this.get(`/tbo/${encodeURIComponent(current.profile.id)}`), current.profile.thread);
			if (profile.id !== current.profile.id || profile.room !== current.room.id) throw Error("Dot's messaging room changed. Reconnect before continuing.");
			const room = dotRoom(await this.get(`/messaging/rooms/${encodeURIComponent(profile.room)}`), profile);
			this.abort.signal.throwIfAborted();
			this.profile = profile; this.room = room; this.metadataAt = Date.now(); this.live?.updateRoom(room);
			current = this.ready();
		}
		const source = current.room.members.find(member => member.dot === current.profile.id)?.avatar ?? current.profile.avatar;
		void this.avatar.get(this.http, source, this.abort.signal);
		const page = await this.history();
		this.abort.signal.throwIfAborted();
		return { ...page, dot: current.profile.id, room: current.room.id, name: current.profile.name,
			path: `/dots/${encodeURIComponent(current.profile.thread)}`, paused: current.profile.paused,
			...this.avatarView };
	}
	async history(before?: string): Promise<DotPage> {
		const { room, identity } = this.ready(), query = new URLSearchParams({ limit: "32" });
		if (before) query.set("before", before);
		return dotPage(await this.get(`/messaging/rooms/${encodeURIComponent(room.id)}/messages?${query}`), room, identity, before);
	}
	async send(request: string, message: string, files: string[], onDispatch: () => void): Promise<DotEntry> {
		const { profile, room, identity } = this.ready();
		if (profile.paused) throw Error("Dot is paused. Resume it before sending.");
		const body = await this.http.json<unknown>("POST", `/messaging/rooms/${encodeURIComponent(room.id)}/messages`, {
			signal: this.abort.signal, onDispatch,
			body: { content: { text: message, ...(files.length ? { attachments: files.map(file => ({ type: "file", file_id: file })) } : {}) }, request_id: request, idempotency_token: request },
		});
		const entry = dotEntry(body, room, identity);
		if (!entry || entry.requestId !== request || entry.message.text !== message
			|| JSON.stringify(entry.files.map(file => file.file).sort()) !== JSON.stringify([...files].sort()))
			throw Error("Dot did not confirm this message. Check delivery before trying again.");
		return entry;
	}
	async attach(file: DotUpload, path: string, onDispatch: () => void): Promise<string> {
		const { room, profile } = this.ready();
		if (file.dot !== profile.id || !["ready", "uploaded"].includes(file.state)) throw Error("Dot attachment is not ready.");
		if (file.remoteId) return file.remoteId;
		const result = await this.http.upload<unknown>(`/messaging/rooms/${encodeURIComponent(room.id)}/files`, { path, name: file.name, mime: file.mime, size: file.size },
			{ signal: this.abort.signal, onDispatch });
		return dotString(dotObject(result).id, "uploaded file identity");
	}
	async download(message: string, attachment: string, path: string, maximum: number, signal: AbortSignal): Promise<{ name: string; size: number; mime: string }> {
		const { room, identity } = this.ready(), query = new URLSearchParams({ around: message, limit: "1" });
		const rows = dotPage(await this.get(`/messaging/rooms/${encodeURIComponent(room.id)}/messages?${query}`), room, identity);
		const file = rows.entries.find(entry => entry.message.id === message)?.files.find(file => file.attachment === attachment);
		if (!file) throw Error("This attachment is no longer available in the Dot conversation.");
		const metadata = dotObject(await this.get(`/messaging/rooms/${encodeURIComponent(room.id)}/files/${encodeURIComponent(file.file)}`));
		if (metadata.status === "error" || metadata.id != null && metadata.id !== file.file) throw Error("Dot file is not available.");
		const address = dotString(metadata.download_url, "file URL", 16_384);
		const downloaded = await this.http.download(address, path, { maximum, signal: AbortSignal.any([signal, this.abort.signal]) });
		return { ...downloaded, name: file.name, mime: file.mime ?? downloaded.mime };
	}
	close(): void { this.abort.abort(); this.live?.close(); this.http.close(); }
}
