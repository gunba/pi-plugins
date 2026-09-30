import { createHash, randomUUID } from "node:crypto";
import { FEEDBACK_ENTRY } from "../shared/feedback.ts";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ChatBlock, ChatMessage, HistoryPage } from "../shared/protocol.ts";
import { LEDGER_ENTRY, readLedger } from "../../../pi-context-ledger/model.ts";
import type { ArtifactStore } from "../../../pi-output-budget/extensions/artifacts.ts";
import { LocalFiles } from "./local-files.ts";
import { projectFileLinks } from "./file-links.ts";
import { ExpiredReference } from "./references.ts";
import { HISTORY_CHARACTERS, HISTORY_COUNT, MESSAGE_TEXT_CHARACTERS, THINKING_CHARACTERS, type HistoryPosition } from "../shared/history.ts";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => value && typeof value === "object" ? value as RecordValue : {};

/** Assets are capabilities minted from observed output, not arbitrary filesystem paths. */
export class Transcript {
	readonly files = new LocalFiles();
	private assets = new Map<string, { mimeType: string; base64: string }>();
	private assetBytes = 0;
	private retained?: string;
	private artifacts = new Set<string>();
	private readonly store?: ArtifactStore;
	constructor(store?: ArtifactStore) { this.store = store; }

	recover(id: string, project: () => void): void {
		this.retained = id;
		try { this.files.recover(id, project); }
		finally { this.retained = undefined; }
	}

	async artifactPage(id: string, offset: number, query?: string) {
		if (!this.store || !this.artifacts.has(id)) throw new ExpiredReference("This captured output is no longer available in the message.");
		this.artifacts.delete(id); this.artifacts.add(id);
		const result = query === undefined ? await this.store.readPage(id, offset)
			: await this.store.searchPage(id, query, offset);
		return { text: result.text, offset, next: result.next_offset, total: result.total_chars };
	}

	toolCall(value: unknown, complete: boolean): Extract<ChatBlock, { type: "toolCall" }> | undefined {
		const block = record(value);
		if (block.type !== "toolCall") return;
		const argumentsText = JSON.stringify(block.arguments ?? {}, null, 2);
		return {
			type: "toolCall", id: String(block.id), name: String(block.name),
			arguments: argumentsText.slice(0, 12_000), truncated: argumentsText.length > 12_000,
			...(complete && argumentsText.length > 12_000 ? { full: this.asset(argumentsText, "text/plain; charset=utf-8") } : {}),
		};
	}

	/** Partial output is a small tail, never an image/asset archive or a details dump. */
	progress(value: unknown, toolName: string): ChatBlock[] {
		const result = record(value), content = result.content;
		const output = ["exec_command", "write_stdin", "patch_and_run"].includes(toolName) ? record(result.details).output : undefined;
		const text = typeof output === "string" ? output.slice(-4000) : (Array.isArray(content) ? content.slice(-4) : []).flatMap(value => {
			const block = record(value);
			return block.type === "text" && typeof block.text === "string" ? [block.text.slice(-4000)] : [];
		}).join("\n").slice(-4000);
		return text ? [{ type: "text", text }] : [];
	}

	private resultDetails(message: RecordValue, blocks: ChatBlock[], cwd?: string): ChatMessage["tool"] {
		const details = record(message.details);
		if (cwd) {
			const path = message.toolName === "read" ? details.sourcePath
				: message.toolName === "view_image" ? details.path
				: ["exec_command", "write_stdin", "patch_and_run"].includes(String(message.toolName)) ? details.full_output_path : undefined;
			if (typeof path === "string") {
				const file = this.files.observePath(path, cwd, undefined, typeof details.firstLine === "number" ? details.firstLine : undefined);
				if (file) blocks.push({ type: "file", file });
			}
		}
		const patch = message.toolName === "apply_patch" ? details
			: message.toolName === "patch_and_run" ? record(details.patch) : {};
		if (Array.isArray(patch.changes)) {
			const changes = patch.changes.flatMap(value => {
				const change = record(value);
				if (typeof change.path !== "string" || typeof change.diff !== "string") return [];
				return [{ path: change.path, diff: change.diff,
					action: ["added", "deleted", "updated", "moved"].includes(String(change.action)) ? String(change.action) : "changed",
					movePath: typeof change.movePath === "string" ? change.movePath : undefined }];
			});
			for (const change of changes.slice(0, 32)) {
				blocks.push({ type: "diff", path: change.path.slice(0, 4000), action: change.action, movePath: change.movePath?.slice(0, 4000),
					text: change.diff.slice(0, 12_000), truncated: change.diff.length > 12_000,
					...(change.diff.length > 12_000 || change.diff.slice(0, 12_000).split("\n").length > 400 ? { full: this.asset(change.diff, "text/plain; charset=utf-8") } : {}) });
			}
			if (changes.length > 32) {
				blocks.push({ type: "text", text: `${changes.length - 32} more changed files.`, full: this.asset(JSON.stringify(changes, null, 2), "text/plain; charset=utf-8") });
			}
		}
		if (message.toolName === "edit" && typeof details.diff === "string") {
			blocks.push({ type: "diff", path: "Edited file", action: "updated", text: details.diff.slice(0, 12_000),
				truncated: details.diff.length > 12_000,
				...(details.diff.length > 12_000 || details.diff.slice(0, 12_000).split("\n").length > 400 ? { full: this.asset(details.diff, "text/plain; charset=utf-8") } : {}) });
		}
		for (const [id, label] of [[details.outputArtifact, "Complete captured output"], [details.full_output_artifact, "Complete process output"],
			[details.artifact, "Captured output"], [details.search_artifact, "Captured search results"]] as const) {
			if (typeof id !== "string" || !/^sha256-[a-f0-9]{64}$/.test(id) || blocks.some(block => block.type === "artifact" && block.id === id)) continue;
			this.artifacts.delete(id); this.artifacts.add(id);
			while (this.artifacts.size > 2048) this.artifacts.delete(this.artifacts.values().next().value!);
			blocks.push({ type: "artifact", id, label });
		}
		const exit = details.exit_code ?? details.exitCode;
		const seconds = details.wall_time_seconds ?? details.wallTimeSeconds;
		const timing = record(details.piMessageTimestamps);
		const duration = typeof timing.startedAt === "number" && Number.isFinite(timing.startedAt)
			&& typeof timing.finishedAt === "number" && Number.isFinite(timing.finishedAt) && timing.finishedAt >= timing.startedAt
			? (timing.finishedAt - timing.startedAt) / 1000 : undefined;
		return {
			state: message.isError === true || typeof details.error === "string" || typeof exit === "number" && exit !== 0 ? "error" : details.aborted === true ? "interrupted" : "done",
			seconds: typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0 ? seconds : Number.isFinite(duration) ? duration : undefined,
			exitCode: typeof exit === "number" && Number.isSafeInteger(exit) ? exit : undefined,
			processId: typeof details.session_id === "number" && Number.isSafeInteger(details.session_id) ? details.session_id : undefined,
			processRunning: typeof details.running === "boolean" ? details.running : undefined,
		};
	}

	private asset(value: string, mimeType: string, base64 = false): string | undefined {
		if (base64 && value.length > Math.ceil(16 * 1024 * 1024 / 3) * 4) return undefined;
		if (!base64 && Buffer.byteLength(value) > 16 * 1024 * 1024) return undefined;
		const bytes = base64 ? Buffer.from(value, "base64") : Buffer.from(value);
		if (bytes.length > 16 * 1024 * 1024) return undefined;
		const id = createHash("sha256").update(mimeType).update(bytes).digest("hex");
		if (!this.assets.has(id)) {
			const encoded = base64 ? value : bytes.toString("base64");
			this.assets.set(id, { mimeType, base64: encoded });
			this.assetBytes += encoded.length;
			while (this.assetBytes > 64 * 1024 * 1024 && this.assets.size > 1) {
				const keys = this.assets.keys();
				let first = keys.next().value!;
				if (first === this.retained) first = keys.next().value!;
				this.assetBytes -= this.assets.get(first)!.base64.length;
				this.assets.delete(first);
			}
		}
		return id;
	}

	getAsset(id: string): { mimeType: string; base64: string } {
		const asset = this.assets.get(id);
		if (!asset) throw new ExpiredReference("This output is no longer available in the message.");
		this.assets.delete(id); this.assets.set(id, asset);
		return asset;
	}

	message(value: unknown, entryId?: string, liveId?: string, order = 0, cwd?: string): ChatMessage | undefined {
		const message = record(value);
		if (message.role === "system" || (message.role === "custom" && message.display === false)) return;
		const role = message.role === "user" || message.role === "assistant" ? message.role
			: message.role === "toolResult" ? "tool" : "note";
		const blocks: ChatBlock[] = [];
		const nested = record(message.nestedCalls);
		const nestedCalls = Array.isArray(nested.calls) ? nested.calls.slice(0, 256).flatMap(value => {
			const call = record(value);
			return typeof call.name === "string" && ["ok", "error", "unfinished"].includes(String(call.status))
				? [{ name: call.name.slice(0, 200), status: call.status as "ok" | "error" | "unfinished",
					...(typeof call.durationMs === "number" && Number.isFinite(call.durationMs) && call.durationMs >= 0 ? { seconds: call.durationMs / 1000 } : {}) }] : [];
		}) : [];
		const linkedFiles: ChatBlock[] = [];
		const content = typeof message.content === "string" ? [{ type: "text", text: message.content }]
			: Array.isArray(message.content) ? message.content : [];
		for (const item of content) {
			const block = record(item);
			if (block.type === "text" || block.type === "thinking") {
				const text = String(block.type === "thinking" ? block.thinking ?? "" : block.text ?? "");
				blocks.push({
					type: block.type, text: text.slice(0, 16_000), truncated: text.length > 16_000,
					...(text.length > 16_000 ? { full: this.asset(text, "text/plain; charset=utf-8") } : {}),
				});
			} else if (block.type === "image" && typeof block.data === "string") {
				const mimeType = String(block.mimeType);
				if (!["image/png", "image/jpeg", "image/gif", "image/webp"].includes(mimeType)) continue;
				const asset = this.asset(block.data, mimeType, true);
				if (asset) blocks.push({ type: "image", asset, mimeType });
				else blocks.push({ type: "text", text: "This image exceeds the viewer's 16 MiB asset limit." });
			} else if (block.type === "toolCall") {
				blocks.push(this.toolCall(block, true)!);
				if (cwd && (entryId || !liveId) && ["read", "edit", "write", "view_image"].includes(String(block.name))) {
					const path = record(block.arguments).path;
					const file = typeof path === "string" ? this.files.observePath(path, cwd) : undefined;
					if (file) linkedFiles.push({ type: "file", file });
				}
			}
		}
		blocks.push(...linkedFiles);
		const timestamp = typeof message.timestamp === "number" ? message.timestamp : 0;
		if (typeof message.errorMessage === "string") blocks.push({ type: "text", text: message.errorMessage.slice(0, 16_000) });
		const tool = role === "tool" ? this.resultDetails(message, blocks, cwd) : undefined;
		const result: ChatMessage = {
			id: entryId ? `entry:${entryId}` : liveId ?? `live:${randomUUID()}`,
			revision: 0, order, entryId, role, timestamp, blocks,
			toolName: typeof message.toolName === "string" ? message.toolName : undefined,
			toolCallId: typeof message.toolCallId === "string" ? message.toolCallId : undefined,
			isError: message.isError === true || message.stopReason === "error" || tool?.state === "error", complete: true, tool,
			...(role === "tool" && nestedCalls.length ? { nested: { calls: nestedCalls, complete: nested.complete === true } } : {}),
		};
		let remaining = MESSAGE_TEXT_CHARACTERS;
		let thinking = THINKING_CHARACTERS;
		result.blocks = result.blocks.map(block => {
			const text = block.type === "toolCall" ? block.arguments : "text" in block ? block.text : undefined;
			if (text === undefined) return block;
			const keep = Math.min(remaining, text.length, block.type === "thinking" ? thinking : Infinity); remaining -= keep;
			if (block.type === "thinking") thinking -= keep;
			if (keep === text.length) return block;
			const full = "full" in block && block.full || this.asset(text, "text/plain; charset=utf-8");
			return block.type === "toolCall" ? { ...block, arguments: text.slice(0, keep), full, truncated: true }
				: { ...block, text: text.slice(0, keep), full, truncated: true };
		});
		return cwd ? projectFileLinks(result, this.files, cwd) : result;
	}

	entry(entry: SessionEntry, order = 0, cwd?: string): ChatMessage | undefined {
		if (entry.type === "message") return this.message(entry.message, entry.id, undefined, order, cwd);
		if (entry.type === "custom_message") return this.message({
			role: "custom", content: entry.content, display: entry.display, timestamp: Date.parse(entry.timestamp),
		}, entry.id, undefined, order, cwd);
		if (entry.type === "custom" && entry.customType === FEEDBACK_ENTRY) {
			const data = record(entry.data);
			if (typeof data.id !== "string" || typeof data.text !== "string" ||
				!["error", "warning"].includes(String(data.level))) return;
			const timestamp = typeof data.timestamp === "number" && Number.isFinite(data.timestamp) ? data.timestamp : Date.parse(entry.timestamp);
			return { id: `entry:${entry.id}`, entryId: entry.id, revision: 0, order, role: "note", timestamp, complete: true,
				feedback: { id: data.id, text: data.text.slice(0, 12_000), level: data.level as "error" | "warning", timestamp,
					generation: typeof data.generation === "string" ? data.generation : "" },
				blocks: [{ type: "text", text: data.text.slice(0, 12_000) }] };
		}
		if (entry.type !== "custom" || entry.customType !== LEDGER_ENTRY) return;
		const ledger = readLedger(entry.data);
		return { id: `entry:${entry.id}`, entryId: entry.id, revision: 0, order, role: "note",
			timestamp: Date.parse(entry.timestamp), complete: true,
			blocks: ledger ? [{ type: "ledger", ledger }] : [{ type: "text", text: "The saved context breakdown cannot be displayed." }] };
	}

	history(branch: readonly SessionEntry[], position: HistoryPosition = {}, live?: unknown, liveId?: string, cwd?: string): Omit<HistoryPage, "generation"> {
		const visible = (entry: SessionEntry) => entry.type === "message" && entry.message.role !== "system"
			&& !(entry.message.role === "custom" && entry.message.display === false)
			|| entry.type === "custom_message" && entry.display
			|| entry.type === "custom" && [LEDGER_ENTRY, FEEDBACK_ENTRY].includes(entry.customType);
		const anchor = position.before ?? position.after ?? position.from;
		const index = anchor ? branch.findIndex(entry => entry.id === anchor) : branch.length;
		if (index < 0 || anchor && !visible(branch[index]!)) throw new Error("History position no longer exists on this branch.");
		const forward = position.after !== undefined || position.from !== undefined;
		const messages: ChatMessage[] = [];
		let cursor = forward ? index + (position.after ? 1 : 0) : index - 1, used = 0;
		let first = branch.length, last = -1;
		// Walk only the requested window, rather than filtering every old entry.
		while (cursor >= 0 && cursor < branch.length && messages.length < HISTORY_COUNT) {
			const entry = branch[cursor]!;
			const message = visible(entry) ? this.entry(entry, cursor, cwd) : undefined;
			if (message) {
				const size = JSON.stringify(message).length;
				if (messages.length && used + size > HISTORY_CHARACTERS) break;
				used += size; messages.push(message); first = Math.min(first, cursor); last = Math.max(last, cursor);
			}
			cursor += forward ? 1 : -1;
		}
		if (!forward) messages.reverse();
		const hasVisible = (start: number, step: number) => {
			for (let i = start; i >= 0 && i < branch.length; i += step) if (visible(branch[i]!)) return true;
			return false;
		};
		const before = first < branch.length && hasVisible(first - 1, -1) ? branch[first]!.id : undefined;
		const after = last >= 0 && hasVisible(last + 1, 1) ? branch[last]!.id : undefined;
		if (!position.before && !after && (!anchor || last >= 0 || forward && cursor >= branch.length) && live) {
			const current = this.message(live, undefined, liveId, branch.length, cwd);
			if (current && !messages.some(message => message.id === current.id)) messages.push({ ...current, complete: false });
		}
		return { messages, before, after, revision: 0 };
	}
}
