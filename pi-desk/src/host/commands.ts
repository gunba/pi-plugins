import type { WorkerCommand } from "../shared/protocol.ts";
import type { UiValue } from "../../../pi-ui/index.ts";
import { CHUNK_BYTES, FILE_COUNT, type UploadCommand } from "../shared/attachments.ts";

export function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object.");
	return value as Record<string, unknown>;
}
export function string(value: unknown, max = 1_000_000): string {
	if (typeof value !== "string" || value.length > max) throw new Error("Invalid text field.");
	return value;
}
export function workerCommandFrom(value: unknown): WorkerCommand {
	const command = commandFrom(value);
	switch (command.kind) {
		case "upload_begin": case "upload_chunk": case "upload_finish": case "upload_discard":
			throw new Error("Use the upload endpoint.");
		default: return command;
	}
}
export function commandFrom(value: unknown): WorkerCommand | UploadCommand {
	const data = object(value);
	const origin = () => {
		const value = object(data.origin);
		return { message: string(value.message, 100), source: value.source === undefined ? undefined : string(value.source, 100) };
	};
	switch (data.kind) {
		case "file": {
			const id = string(data.id, 64);
			if (data.operation === "info") return { kind: "file", id, operation: "info", origin: origin() };
			const version = string(data.version, 64);
			if (data.offset !== undefined && (!Number.isSafeInteger(data.offset) || Number(data.offset) < 0)) throw new Error("Invalid file position.");
			const offset = data.offset === undefined ? undefined : Number(data.offset);
			if (data.operation === "chunk" && offset !== undefined) return { kind: "file", id, operation: "chunk", version, offset, origin: origin() };
			if (data.operation === "text") {
				if (data.line !== undefined && (!Number.isSafeInteger(data.line) || Number(data.line) < 1)) throw new Error("Invalid line.");
				if (data.line !== undefined && offset !== undefined) throw new Error("Use a line or byte position, not both.");
				return { kind: "file", id, operation: "text", version, offset, line: data.line === undefined ? undefined : Number(data.line), origin: origin() };
			}
			throw new Error("Invalid file operation.");
		}
		case "upload_begin":
			if (!Number.isSafeInteger(data.size)) throw new Error("Invalid file size.");
			return { kind: data.kind, name: string(data.name, 255), size: Number(data.size) };
		case "upload_chunk":
			if (!Number.isSafeInteger(data.offset)) throw new Error("Invalid upload position.");
			return { kind: data.kind, id: string(data.id, 64), offset: Number(data.offset), base64: string(data.base64, CHUNK_BYTES / 3 * 4) };
		case "upload_finish": case "upload_discard": return { kind: data.kind, id: string(data.id, 64) };
		case "snapshot": case "abort": case "reload": case "shutdown": return { kind: data.kind };
		case "history": {
			if (["before", "after", "from"].filter(key => data[key] !== undefined).length > 1) throw new Error("Use one history position.");
			return { kind: data.kind, before: data.before === undefined ? undefined : string(data.before, 100),
				after: data.after === undefined ? undefined : string(data.after, 100),
				from: data.from === undefined ? undefined : string(data.from, 100),
				source: data.source === undefined ? undefined : string(data.source, 100) };
		}
		case "tree": return { kind: data.kind, after: data.after === undefined ? undefined : string(data.after, 100) };
		case "navigate": return { kind: data.kind, entry: string(data.entry, 100), summarize: data.summarize === true };
		case "fork":
			if (data.position !== "before" && data.position !== "at") throw new Error("Invalid fork position.");
			return { kind: data.kind, entry: string(data.entry, 100), position: data.position };
		case "compact": return { kind: data.kind, instructions: data.instructions === undefined ? undefined : string(data.instructions, 10_000) };
		case "asset": return { kind: data.kind, id: string(data.id, 100), origin: origin() };
		case "artifact":
			if (!Number.isSafeInteger(data.offset) || Number(data.offset) < 0) throw new Error("Invalid artifact position.");
			return { kind: data.kind, id: string(data.id, 80), offset: Number(data.offset), origin: origin(),
				query: data.query === undefined ? undefined : string(data.query, 1000) };
		case "name": return { kind: data.kind, name: string(data.name, 300) };
		case "model": return { kind: data.kind, provider: string(data.provider, 200), id: string(data.id, 300) };
		case "thinking": return { kind: data.kind, level: string(data.level, 30) };
		case "answer": return { kind: data.kind, id: string(data.id, 100), answer: data.answer };
		case "action":
			if (!Number.isSafeInteger(data.revision) || Number(data.revision) < 0) throw new Error("Invalid view revision.");
			return { kind: data.kind, view: string(data.view, 200), revision: Number(data.revision),
				action: string(data.action, 200), value: data.value as UiValue | undefined };
		case "prompt":
			if (data.behavior !== undefined && data.behavior !== "steer" && data.behavior !== "followUp") throw new Error("Invalid queue behavior.");
			if (data.attachments !== undefined && (!Array.isArray(data.attachments) || data.attachments.length > FILE_COUNT)) throw new Error("Invalid attachments.");
			return { kind: data.kind, text: string(data.text), behavior: data.behavior,
				attachments: data.attachments?.map((id: unknown) => string(id, 64)) };
		default: throw new Error("Unknown command.");
	}
}
