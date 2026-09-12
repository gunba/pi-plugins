import { createHash, randomUUID } from "node:crypto";
import { calculateCost, type Api, type Context, type Model, type Usage } from "@earendil-works/pi-ai";
import { buildContextEntries, sessionEntryToContextMessages, type AgentSession, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { object, type JsonObject } from "./diagnostics.ts";

export const CHECKPOINT = "codexWireCheckpoint";
type AgentMessage = AgentSession["messages"][number];
export const CHECKPOINT_CAPTION = "Codex checkpoint. Conversation state is stored in this entry and requires Codex Wire to continue.";
export interface Checkpoint { version: 1; binding: string; output: JsonObject[]; reportedUsage?: JsonObject; }
type Carrier = { role: "user"; content: string; timestamp: number; codexWireCheckpoint: Checkpoint };

export function checkpointBinding(url: string, headers: Headers): string {
	const endpoint = new URL(url);
	const account = headers.get("chatgpt-account-id");
	if (!account) throw new Error("Codex checkpoint requires an authenticated account.");
	return createHash("sha256").update(JSON.stringify([endpoint.origin, endpoint.pathname.replace(/\/$/, ""), endpoint.search, account])).digest("hex");
}

/** The endpoint returns replacement history. Keep its opaque items byte-for-byte. */
export function validateCheckpoint(value: unknown): Checkpoint {
	const checkpoint = object(value);
	if (checkpoint.version !== 1 || typeof checkpoint.binding !== "string" || !/^[a-f0-9]{64}$/.test(checkpoint.binding)
		|| !Array.isArray(checkpoint.output) || !checkpoint.output.length) throw new Error("Invalid Codex checkpoint.");
	let compacted = false;
	for (const value of checkpoint.output) {
		const item = object(value);
		if (item.type === "context_compaction") {
			if (item.encrypted_content !== undefined && typeof item.encrypted_content !== "string") throw new Error("Invalid Codex context checkpoint.");
			if (typeof item.encrypted_content === "string" && item.encrypted_content) compacted = true;
		} else if (["compaction", "compaction_summary"].includes(String(item.type))) {
			if (typeof item.encrypted_content !== "string" || !item.encrypted_content) throw new Error("Codex checkpoint has no encrypted content.");
			compacted = true;
		} else if (item.type === "agent_message" || (item.type === "message" && ["user", "assistant"].includes(String(item.role)))) {
			if (!Array.isArray(item.content)) throw new Error("Invalid message in Codex checkpoint.");
		} else throw new Error("Unsupported item in Codex checkpoint.");
	}
	if (!compacted) throw new Error("Codex compaction returned no checkpoint.");
	return checkpoint as unknown as Checkpoint;
}

/** Codex 0.153.4 compact_remote::should_keep_compacted_history_item. */
export function createCheckpoint(binding: string, output: JsonObject[], reportedUsage?: JsonObject): Checkpoint {
	const transient = new Set(["additional_tools", "reasoning", "compaction_trigger", "local_shell_call", "function_call",
		"tool_search_call", "function_call_output", "tool_search_output", "custom_tool_call", "custom_tool_call_output", "web_search_call", "image_generation_call"]);
	const retained = output.filter(item => !transient.has(String(item.type))
		&& !(item.type === "message" && !["user", "assistant"].includes(String(item.role))))
		.map(item => item.type === "compaction_summary" ? { ...item, type: "compaction" } : item);
	// Pi's user messages have no Codex session-prefix parser; preserve every user message.
	return structuredClone(validateCheckpoint({ version: 1, binding, output: retained, ...(reportedUsage ? { reportedUsage } : {}) }));
}

/** Account only for counters actually returned by the endpoint. Keep unknown usage absent. */
export function checkpointUsage(checkpoint: Checkpoint, model: Model<Api>): Usage | undefined {
	const raw = checkpoint.reportedUsage;
	if (!raw) return;
	const input = raw.input_tokens, output = raw.output_tokens;
	const cached = object(raw.input_tokens_details).cached_tokens ?? 0;
	const reasoning = object(raw.output_tokens_details).reasoning_tokens;
	if (![input, output, cached].every(value => typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
		|| (cached as number) > (input as number)) return;
	const usage: Usage = { input: (input as number) - (cached as number), output: output as number, cacheRead: cached as number, cacheWrite: 0,
		totalTokens: (input as number) + (output as number), cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	if (typeof reasoning === "number" && Number.isSafeInteger(reasoning) && reasoning >= 0 && reasoning <= usage.output) usage.reasoning = reasoning;
	calculateCost(model, usage);
	return usage;
}

export function entryCheckpoint(entry: SessionEntry): unknown {
	if (entry.type === "compaction" || entry.type === "branch_summary") return object(entry.details)[CHECKPOINT];
	if (entry.type === "custom_message" && entry.customType === "pi-subagents/fork-summary-v1") {
		return object(object(entry.details).sourceDetails)[CHECKPOINT];
	}
	return undefined;
}

function carrier(value: unknown, timestamp: number): Carrier {
	// Validation occurs at the provider boundary: Pi catches context-hook errors.
	return { role: "user", content: `codex-checkpoint:${randomUUID()}`, timestamp,
		[CHECKPOINT]: structuredClone(value) as Checkpoint };
}

export function checkpointMessages(entries: SessionEntry[]): AgentMessage[] {
	return entries.flatMap(entry => {
		const checkpoint = entryCheckpoint(entry);
		return checkpoint === undefined ? sessionEntryToContextMessages(entry)
			: [carrier(checkpoint, Date.parse(entry.timestamp))];
	});
}

/** Replace only typed session summaries; user text is never a checkpoint discriminator. */
export function projectCheckpoints(messages: AgentMessage[], entries: SessionEntry[]): AgentMessage[] {
	return messages.map(message => {
		if (message.role === "custom" && message.customType === "pi-subagents/fork-summary-v1") {
			const value = object(object(message.details).sourceDetails)[CHECKPOINT];
			if (value !== undefined) return carrier(value, message.timestamp);
		}
		if (message.role !== "compactionSummary" && message.role !== "branchSummary") return message;
		const matches = entries.filter(entry =>
			((message.role === "compactionSummary" && entry.type === "compaction")
				|| (message.role === "branchSummary" && entry.type === "branch_summary"))
			&& Date.parse(entry.timestamp) === message.timestamp && entry.summary === message.summary);
		if (matches.length !== 1) return message;
		const value = entryCheckpoint(matches[0]);
		return value === undefined ? message : carrier(value, message.timestamp);
	});
}

export function assertCheckpointContext(context: Context, provider: string, expected?: SessionEntry[]): void {
	const carriers = context.messages.filter(message => Object.hasOwn(message, CHECKPOINT));
	if (expected && expected.filter(entry => entryCheckpoint(entry) !== undefined).length > carriers.length) {
		throw new Error("Codex checkpoint was lost during context conversion. Request cancelled.");
	}
	if (carriers.length && provider !== "openai-codex") throw new Error("This context requires Codex Wire. Select a Codex model or branch before its checkpoint.");
	for (const message of carriers) validateCheckpoint(object(message)[CHECKPOINT]);
}

/** Splice into the native serializer output, retaining deferred tools and call/result pairing. */
export function replayCheckpoints(body: JsonObject, context: Context, binding: string): JsonObject {
	const replacements = new Map<string, JsonObject[]>();
	for (const message of context.messages) {
		if (!Object.hasOwn(message, CHECKPOINT)) continue;
		const checkpoint = validateCheckpoint(object(message)[CHECKPOINT]);
		if (checkpoint.binding !== binding) throw new Error("Codex checkpoint belongs to a different account or endpoint. Request cancelled.");
		if (message.role !== "user" || typeof message.content !== "string" || replacements.has(message.content)) throw new Error("Invalid Codex checkpoint carrier.");
		replacements.set(message.content, checkpoint.output);
	}
	if (!replacements.size) return body;
	if (!Array.isArray(body.input)) throw new Error("Missing Codex request input.");
	const input = body.input.flatMap(value => {
		const item = object(value);
		const content = item.content;
		const text = typeof content === "string" ? content
			: Array.isArray(content) && content.length === 1 ? object(content[0]).text : undefined;
		if (item.role !== "user" || typeof text !== "string" || !replacements.has(text)) return [value];
		const output = replacements.get(text)!;
		replacements.delete(text);
		return structuredClone(output);
	});
	if (replacements.size) throw new Error("Codex checkpoint carrier was changed or omitted by the serializer. Request cancelled.");
	return { ...body, input };
}

export function compactionPrefix(branch: SessionEntry[], firstKeptEntryId: string): SessionEntry[] {
	const active = buildContextEntries(branch);
	const index = active.findIndex(entry => entry.id === firstKeptEntryId);
	if (index < 1) throw new Error("No complete context prefix is available for Codex compaction.");
	return active.slice(0, index);
}
