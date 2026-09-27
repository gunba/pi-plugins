import { createReadStream } from "node:fs";
import { finished } from "node:stream/promises";
import parser, { type Token } from "stream-json/parser.js";
import type { SavedSession } from "../shared/protocol.ts";

interface Frame { path: string; key: string; array: boolean; type?: string; text?: string }
interface RecordPreview { type?: string; id?: string; cwd?: string; name?: string; timestamp?: string;
	role?: string; time?: number; text: string }
const fields = new Map<string, number>([
	["$.type", 40], ["$.id", 1024], ["$.cwd", 32768], ["$.name", 301], ["$.timestamp", 80],
	["$.message.role", 40], ["$.message.timestamp", 40], ["$.message.content", 201],
	["$.message.content.*.type", 40], ["$.message.content.*.text", 201],
]);
const containers = new Set(["$", "$.message", "$.message.content", "$.message.content.*"]);
const clip = (text: string, limit: number) => text.slice(0, limit - (/[\uD800-\uDBFF]/.test(text[limit - 1] ?? "")
	&& /[\uDC00-\uDFFF]/.test(text[limit] ?? "") ? 1 : 0));

/** A projection of the documented JSONL fields, never an assembled transcript. */
class RecordReader {
	private parse = parser.asStream({ packValues: false, streamValues: true });
	private frames: Frame[] = [];
	private target = "";
	private value = "";
	private key = false;
	private limit = 0;
	private broken = false;
	private complete = false;
	private record: RecordPreview = { text: "" };
	constructor() {
		this.parse.on("data", (token: Token) => {
			try { this.token(token); } catch { this.broken = true; this.parse.destroy(); }
		});
		this.parse.on("error", () => { this.broken = true; });
	}
	private path(): string {
		const parent = this.frames.at(-1);
		return parent?.path ? `${parent.path}.${parent.array ? "*" : parent.key}` : "";
	}
	private token(token: Token): void {
		switch (token.name) {
			case "startObject": case "startArray": {
				if (this.frames.length >= 64) throw new Error("Session record is too deeply nested.");
				const path = this.frames.length ? this.path() : "$";
				this.frames.push({ path: containers.has(path) ? path : "", key: "", array: token.name === "startArray" });
				break;
			}
			case "endObject": case "endArray": {
				const frame = this.frames.pop()!;
				if (frame.path === "$.message.content.*" && frame.type === "text" && frame.text) {
					this.record.text = `${this.record.text}${this.record.text ? " " : ""}${frame.text}`.slice(0, 201);
				}
				if (!this.frames.length) this.complete = token.name === "endObject";
				break;
			}
			case "startKey": case "startString": case "startNumber":
				this.key = token.name === "startKey"; this.target = this.path(); this.value = "";
				this.limit = this.key ? 128 : fields.get(this.target) ?? 0;
				break;
			case "stringChunk": case "numberChunk":
				if (this.value.length < this.limit) this.value += token.value.slice(0, this.limit - this.value.length);
				break;
			case "endKey":
				this.frames.at(-1)!.key = this.value; this.key = false;
				break;
			case "endString": case "endNumber": {
				if (!this.limit) break;
				if ((token.name === "endNumber") !== (this.target === "$.message.timestamp")) break;
				const value = this.value;
				if (this.target.startsWith("$.message.content.*.")) {
					const frame = this.frames.at(-1)!;
					if (this.target.endsWith(".type")) frame.type = value;
					else frame.text = value;
				} else switch (this.target) {
					case "$.type": this.record.type = value; break;
					case "$.id": this.record.id = value; break;
					case "$.cwd": this.record.cwd = value; break;
					case "$.name": this.record.name = value; break;
					case "$.timestamp": this.record.timestamp = value; break;
					case "$.message.role": this.record.role = value; break;
					case "$.message.timestamp": this.record.time = Number(value); break;
					case "$.message.content": this.record.text = value; break;
				}
				break;
			}
		}
	}
	async write(text: string): Promise<void> {
		if (this.broken) return;
		await new Promise<void>(resolve => this.parse.write(text, error => { if (error) this.broken = true; resolve(); }));
	}
	async finish(): Promise<RecordPreview | undefined> {
		if (this.broken) { this.parse.destroy(); return; }
		try {
			const ended = finished(this.parse, { cleanup: true });
			this.parse.end(); await ended;
		} catch { return; }
		return this.complete ? this.record : undefined;
	}
	close(): void { this.parse.destroy(); }
}

export async function readSessionMetadata(file: string, modified: number, signal?: AbortSignal): Promise<SavedSession | undefined> {
	let reader = new RecordReader(), lineStarted = false, header: RecordPreview | undefined;
	let invalid = 0, messageCount = 0, name: string | undefined, firstMessage = "", activity = 0;
	const finish = async () => {
		if (!lineStarted) { reader.close(); return; }
		const entry = await reader.finish();
		if (!entry) { invalid++; return; }
		if (!header) {
			if (entry.type !== "session" || !entry.id || typeof entry.cwd !== "string") throw new Error("Invalid session header.");
			header = entry; return;
		}
		if (entry.type === "session_info") name = entry.name?.trim() || undefined;
		if (entry.type !== "message") return;
		messageCount++;
		if (entry.role !== "user" && entry.role !== "assistant") return;
		const time = entry.time ?? Date.parse(entry.timestamp ?? "");
		if (Number.isFinite(time) && Math.abs(time) <= 8.64e15) activity = Math.max(activity, time);
		if (!firstMessage && entry.role === "user") firstMessage = clip(entry.text, 200);
	};
	try {
		for await (const chunk of createReadStream(file, { encoding: "utf8", highWaterMark: 64 * 1024, signal })) {
			const text = String(chunk);
			let start = 0;
			for (;;) {
				const newline = text.indexOf("\n", start), end = newline < 0 ? text.length : newline;
				const part = text.slice(start, end);
				if (part.trim()) lineStarted = true;
				await reader.write(part);
				if (newline < 0) break;
				await finish(); reader = new RecordReader(); lineStarted = false; start = newline + 1;
			}
		}
		await finish();
	} finally { reader.close(); }
	if (!header) return;
	const created = Date.parse(header.timestamp ?? "");
	return { id: header.id!, file, cwd: header.cwd!, name: name ? clip(name, 300) : undefined,
		firstMessage, messageCount, modified: new Date(activity || (Number.isFinite(created) ? created : modified)).toISOString(),
		...(invalid ? { warning: `${invalid} unreadable record${invalid === 1 ? "" : "s"}; preview may be incomplete.` } : {}) };
}
