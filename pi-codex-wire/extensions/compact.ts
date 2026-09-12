import { isDeepStrictEqual } from "node:util";
import { object, type Diagnostics, type JsonObject } from "./diagnostics.ts";
import { networkErrorCodes } from "./network-diagnostics.ts";
import type { Exchange, WireTransport } from "./transport.ts";

export interface CompactResult { output: JsonObject[]; usage?: JsonObject }

/** Codex 0.153.4 compact_remote_v2_attempt: a Responses request with one trigger. */
export function compactBody(source: JsonObject): JsonObject {
	if (typeof source.model !== "string" || !source.model || !Array.isArray(source.input)
		|| source.input.some(item => object(item).type === "compaction_trigger")) {
		throw new TypeError("Invalid Codex compaction request.");
	}
	const body = structuredClone(source);
	delete body.previous_response_id;
	delete body.generate;
	return { ...body, input: [...body.input as unknown[], { type: "compaction_trigger" }],
		store: false, stream: true, tool_choice: "auto" };
}

const tokens = (text: string) => Math.ceil(Buffer.byteLength(text) / 4);
function truncateText(text: string, budget: number): string {
	const bytes = Buffer.from(text), keep = budget * 4;
	let head = Math.ceil(keep / 2), tail = bytes.length - Math.floor(keep / 2);
	while (head > 0 && (bytes[head] & 0xc0) === 0x80) head--;
	while (tail < bytes.length && (bytes[tail] & 0xc0) === 0x80) tail++;
	return `${bytes.subarray(0, head).toString()}…${Math.ceil((tail - head) / 4)} tokens truncated…${bytes.subarray(tail).toString()}`;
}

/** Retain user messages ahead of the new checkpoint, using Codex's 64k text budget.
 * Pi supplies its own separate recent tail. Images in retained messages stay intact.
 * Pi has no native agent_message or client-authored developer-message sidecars.
 */
export function retainedCompactionInput(input: unknown[]): JsonObject[] {
	const retained: JsonObject[] = [];
	let remaining = 64_000;
	for (const value of [...input].reverse()) {
		const item = object(value);
		if (!remaining || (item.type !== undefined && item.type !== "message") || item.role !== "user" || !Array.isArray(item.content)) continue;
		// Pi's serializer uses the valid implicit message type for ordinary users.
		const copy: JsonObject = structuredClone({ ...item, type: "message" });
		const content = copy.content as JsonObject[];
		const size = Math.max(1, content.reduce((sum, part) => sum + (typeof part.text === "string" ? tokens(part.text) : 0), 0));
		if (size <= remaining) remaining -= size;
		else {
			copy.content = content.filter(part => {
				if (typeof part.text !== "string") return true;
				if (!remaining) return false;
				const size = tokens(part.text);
				if (size > remaining) part.text = truncateText(part.text, remaining);
				remaining = Math.max(0, remaining - size);
				return !!part.text;
			});
			remaining = 0;
		}
		retained.push(copy);
	}
	return retained.reverse();
}

async function* events(response: Response, signal?: AbortSignal): AsyncGenerator<JsonObject> {
	if (!response.body) throw new Error("Codex compaction returned no stream.");
	const reader = response.body.getReader(), decoder = new TextDecoder();
	let buffer = "";
	const abort = () => { void reader.cancel().catch(() => {}); };
	signal?.addEventListener("abort", abort, { once: true });
	try {
		while (true) {
			signal?.throwIfAborted();
			const { done, value } = await reader.read();
			signal?.throwIfAborted();
			buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
			if (done && buffer.trim()) buffer += "\n\n";
			let boundary: RegExpExecArray | null;
			while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
				const block = buffer.slice(0, boundary.index);
				buffer = buffer.slice(boundary.index + boundary[0].length);
				const data = block.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n").trim();
				if (!data || data === "[DONE]") continue;
				let event: JsonObject;
				try { event = object(JSON.parse(data)); }
				catch { throw new Error("Codex compaction returned invalid event JSON."); }
				yield event;
			}
			if (buffer.length > 50 * 1024 * 1024) throw new Error("Codex compaction event exceeds the transport limit.");
			if (done) break;
		}
	} finally {
		signal?.removeEventListener("abort", abort);
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}

function responseError(error: JsonObject): Error {
	if (["insufficient_quota", "usage_limit_reached", "usage_not_included", "billing_hard_limit_reached"].some(code => error.code === code || error.type === code)) {
		return new Error("Codex compaction failed: quota exceeded.");
	}
	if (error.code === "context_length_exceeded") return new Error("Codex compaction failed: context window exceeded.");
	if (["server_error", "internal_error"].includes(String(error.code))) return new Error("Codex compaction server error.");
	if (["rate_limit_exceeded", "rate_limit_error"].includes(String(error.code))) return new Error("Codex compaction rate limit exceeded.");
	return new Error("Codex compaction response failed.");
}

/** One caller-owned attempt through Wire's transport. No prose decoder or replay loop. */
export async function requestCompact(exchange: Exchange, diagnostics: Diagnostics,
	transport: Pick<WireTransport, "request">): Promise<CompactResult> {
	exchange.signal?.throwIfAborted();
	const started = Date.now();
	try {
		const response = await transport.request({ ...exchange, skipPrewarm: true });
		if (!response.ok) {
			if (response.status === 429) {
				let error: JsonObject = {};
				try { error = object(object(await response.json()).error); } catch { exchange.signal?.throwIfAborted(); }
				const classified = responseError(error);
				if (classified.message.includes("quota exceeded")) throw classified;
			} else await response.body?.cancel();
			throw Object.assign(new Error(`Codex compaction failed (HTTP ${response.status})`), { status: response.status });
		}
		let checkpoint: JsonObject | undefined;
		for await (const event of events(response, exchange.signal)) {
			if (event.type === "error" || event.type === "response.failed") throw responseError(object(event.error ?? object(event.response).error));
			if (event.type === "response.incomplete") throw new Error("Codex compaction response was incomplete.");
			if (event.type === "response.output_item.done" && object(event.item).type === "compaction") {
				if (checkpoint) throw new Error("Codex compaction returned multiple checkpoints.");
				checkpoint = object(event.item);
				if (typeof checkpoint.encrypted_content !== "string" || !checkpoint.encrypted_content) throw new Error("Codex compaction returned an empty checkpoint.");
			}
			if (event.type !== "response.completed") continue;
			const completed = object(event.response);
			if (typeof completed.id !== "string" || !completed.id || (completed.status !== undefined && completed.status !== "completed")) throw new Error("Codex compaction completion was invalid.");
			if (!checkpoint) throw new Error("Codex compaction returned no checkpoint.");
			if (Array.isArray(completed.output) && completed.output.length) {
				const copies = completed.output.filter(item => object(item).type === "compaction");
				if (copies.length !== 1 || !isDeepStrictEqual(copies[0], checkpoint)) throw new Error("Codex compaction output conflicted with its completion.");
			}
			exchange.signal?.throwIfAborted();
			const output = [...retainedCompactionInput(exchange.body.input as unknown[]), checkpoint];
			const usage = completed.usage !== undefined ? object(completed.usage) : undefined;
			diagnostics.write({ kind: "compact-completed", ...exchange.trace, requestId: exchange.requestId,
				elapsedMs: Date.now() - started, outputItems: output.length, usageReported: usage !== undefined });
			return { output, ...(usage ? { usage } : {}) };
		}
		throw new Error("Codex compaction stream ended before a terminal response event.");
	} catch (error) {
		diagnostics.write({ kind: "compact-failure", ...exchange.trace, requestId: exchange.requestId,
			elapsedMs: Date.now() - started, errorCodes: networkErrorCodes(error), abortSource: exchange.signal?.aborted ? "request-signal" : "none" });
		if (!exchange.signal?.aborted && error instanceof Error
			&& ["Codex WebSocket stream failed", "Codex WebSocket send failed", "Codex WebSocket retry failed"].includes(error.message)) {
			// Preserve Pi's classifier and budget while identifying Wire's transient socket failures.
			throw new Error("Codex compaction WebSocket error.", { cause: error });
		}
		throw error;
	}
}
