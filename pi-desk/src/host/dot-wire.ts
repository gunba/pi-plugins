import type { DotAttachment, DotMessage } from "../shared/dot.ts";
import type { DotIdentity } from "./dot-auth.ts";

type ObjectValue = Record<string, unknown>;
export const dotObject = (value: unknown): ObjectValue => value && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : {};
const text = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;
export function dotString(value: unknown, label: string, maximum = 2000): string {
	if (typeof value !== "string" || !value || value.length > maximum) throw Error(`Dot returned an invalid ${label}.`);
	return value;
}
export interface DotProfile {
	id: string; name: string; room: string; thread: string; paused: boolean; avatar?: string;
}
export interface DotMember { id: string; dot?: string; name?: string; avatar?: string }
export interface DotRoom { id: string; dot: string; name: string; members: DotMember[] }
export interface DotFileReference { attachment: string; file: string; name: string; mime?: string }
export interface DotEntry { message: DotMessage; requestId?: string; files: DotFileReference[] }
export interface DotPage { entries: DotEntry[]; before?: string }

export function dotProfile(value: unknown, thread?: string): DotProfile {
	const data = dotObject(value);
	if (data.status !== "active" || typeof data.is_paused !== "boolean") throw Error("This Dot is not available.");
	return { id: dotString(data.id, "identity"), name: dotString(data.display_name, "name"),
		room: dotString(data.messaging_room_id, "messaging room"), thread: dotString(data.active_root_thread_id ?? thread, "thread"),
		paused: data.is_paused, avatar: text(data.avatar_url) };
}
export function dotRoom(value: unknown, profile: DotProfile): DotRoom {
	const data = dotObject(value);
	if (data.id !== profile.room || data.aeon_id !== profile.id || data.type !== "DM" || data.app_source !== "chatgpt:messaging" || !Array.isArray(data.members))
		throw Error("The Dot messaging room changed. Reconnect before continuing.");
	const snapshots = Array.isArray(data.member_profile_snapshots) ? data.member_profile_snapshots.map(dotObject) : [];
	return { id: profile.room, dot: profile.id, name: text(data.name) || profile.name, members: data.members.map(value => {
		const member = dotObject(value), snapshot = snapshots.find(item => item.account_user_id === member.account_user_id);
		return { id: dotString(member.account_user_id, "member"), dot: text(member.aeon_id), name: text(member.name) || text(snapshot?.name), avatar: text(member.avatar_url) };
	}) };
}
function assistantText(raw: unknown): string {
	if (!Array.isArray(raw)) return "";
	return raw.flatMap(value => {
		const message = dotObject(value), meta = dotObject(message.metadata), content = dotObject(message.content);
		if (dotObject(message.author).role !== "assistant" || message.channel === "analysis" || meta.is_hidden === true || meta.hidden === true
			|| meta.is_visually_hidden_from_conversation === true || message.recipient != null && message.recipient !== "all"
			|| !["text", "multimodal_text"].includes(String(content.content_type))) return [];
		const body = text(content.text) ?? (Array.isArray(content.parts) ? content.parts.filter(part => typeof part === "string").join("") : "");
		return /^::\s*SKIP_COMPLETION\s*::$/.test(body.trim()) ? [] : [body];
	}).join("\n\n");
}
export function dotEntry(value: unknown, room: DotRoom, identity: DotIdentity): DotEntry | undefined {
	const data = dotObject(value);
	if (data.deleted_at || data.delivery_state || data.deliveryState) return;
	const content = dotObject(data.content);
	if (content.type === "message_error") return;
	const raw = Array.isArray(data.raw_messages), sender = room.members.find(member => member.id === data.account_user_id);
	const attachments: DotAttachment[] = [], files: DotFileReference[] = [];
	const source = raw ? data.attachments : content.attachments;
	for (const value of Array.isArray(source) ? source : []) {
		const item = dotObject(value), file = dotObject(item.file), kind = text(item.type) ?? "file";
		const id = text(item.attachment_id) ?? text(item.file_id) ?? text(item.post_id) ?? text(item.conversation_id) ?? text(item.url);
		if (!id) continue;
		const fileId = text(item.file_id) ?? text(file.id) ?? text(file.file_id);
		const name = text(file.name) ?? text(item.name) ?? text(item.title) ?? "Attachment", mime = text(file.mime_type) ?? text(item.mime_type);
		const size = typeof file.size_bytes === "number" && Number.isSafeInteger(file.size_bytes) && file.size_bytes >= 0 ? file.size_bytes : undefined;
		const downloadable = kind === "file" && !!fileId;
		attachments.push({ id, name, kind, mime, size, downloadable });
		if (downloadable) files.push({ attachment: id, file: fileId!, name, mime });
	}
	const body = raw ? assistantText(data.raw_messages) : text(content.text) ?? text(data.preview) ?? "";
	if (raw && !body && !attachments.length) return;
	const date = new Date(dotString(data.created_at, "message timestamp"));
	if (!Number.isFinite(date.getTime())) throw Error("Dot returned an invalid message timestamp.");
	return { requestId: text(data.request_id), files, message: {
		id: dotString(data.id, "message identity"), author: raw || sender?.dot === room.dot ? "dot"
			: data.account_user_id === identity.accountUserId ? "owner" : "other",
		name: sender?.name ?? (raw ? room.name : undefined), text: body, created: date.toISOString(), attachments,
	} };
}
export function dotPage(value: unknown, room: DotRoom, identity: DotIdentity, before?: string): DotPage {
	const data = dotObject(value);
	if (!Array.isArray(data.items)) throw Error("Dot returned an unrecognized history page.");
	const entries = data.items.flatMap(item => { const entry = dotEntry(item, room, identity); return entry ? [entry] : []; });
	// The service can omit cursors on a non-empty last page; native clients probe from its first raw ID.
	const cursor = text(data.prev_cursor) ?? text(dotObject(data.items[0]).id);
	return { entries, before: cursor && cursor !== before ? cursor : undefined };
}
