import { Buffer } from "node:buffer";
import { existsSync, readFileSync } from "node:fs";
import { parseSessionEntries } from "@earendil-works/pi-coding-agent";
import type {
	ExtensionAPI,
	ExtensionContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";

const NOTICE_THRESHOLD_BYTES = 1024 * 1024;

type MutableRecord = Record<string, unknown>;
type ResidentSessionManager = Pick<
	ExtensionContext["sessionManager"],
	"getEntries" | "getBranch" | "buildContextEntries" | "getSessionFile" | "getSessionId"
>;

export interface ResidentPruneReport {
	totalEntries: number;
	activeEntries: number;
	prunedEntries: number;
	estimatedBytesReleased: number;
	compactionId?: string;
}

function record(value: unknown): MutableRecord | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value as MutableRecord
		: undefined;
}

function estimatedBytes(value: unknown): number {
	let total = 0;
	const seen = new WeakSet<object>();
	const pending: unknown[] = [value];

	while (pending.length > 0) {
		const current = pending.pop();
		if (typeof current === "string") {
			total += Buffer.byteLength(current);
			continue;
		}
		if (typeof current === "number" || typeof current === "bigint") {
			total += 8;
			continue;
		}
		if (typeof current === "boolean") {
			total += 4;
			continue;
		}
		if (current === null || current === undefined || typeof current !== "object") {
			continue;
		}
		if (seen.has(current)) continue;
		seen.add(current);

		if (Array.isArray(current)) {
			pending.push(...current);
			continue;
		}
		for (const [key, child] of Object.entries(current)) {
			total += Buffer.byteLength(key);
			pending.push(child);
		}
	}

	return total;
}

function clearField(target: MutableRecord, key: string, replacement?: unknown): number {
	if (!(key in target)) return 0;
	const previous = target[key];
	const before = estimatedBytes(previous);
	const after = estimatedBytes(replacement);
	if (before === 0 && after === 0) return 0;
	if (replacement === undefined) delete target[key];
	else target[key] = replacement;
	return Math.max(0, before - after);
}

function pruneEntryPayload(entry: SessionEntry, preserveCustomState: boolean): number {
	const mutableEntry = entry as unknown as MutableRecord;

	switch (entry.type) {
		case "message": {
			const message = record(mutableEntry.message);
			if (!message) return 0;
			let released = 0;
			if ("content" in message) released += clearField(message, "content", []);
			if ("output" in message) released += clearField(message, "output", "");
			if ("details" in message) {
				const ids = message.role === "toolResult" && message.toolName === "party_read"
					? record(message.details)?.partyMessageIds : undefined;
				released += clearField(message, "details", Array.isArray(ids)
					? { partyMessageIds: ids.filter((id): id is string => typeof id === "string") } : undefined);
			}
			return released;
		}
		case "compaction":
		case "branch_summary":
			return clearField(mutableEntry, "summary", "")
				+ clearField(mutableEntry, "details");
		case "custom_message": {
			// Delivery IDs are durable recovery state, not transcript payload.
			// Keep individual/batch IDs, never the report bodies.
			const details = entry.customType === "pi-subagents/notice" || entry.customType === "pi-party/message" ? record(mutableEntry.details) : undefined;
			const receipt = {
				...(typeof details?.messageId === "string" ? { messageId: details.messageId } : {}),
				...(Array.isArray(details?.messageIds) ? { messageIds: details.messageIds.filter((id): id is string => typeof id === "string") } : {}),
			};
			return clearField(mutableEntry, "content", [])
				+ clearField(mutableEntry, "details",
					Object.keys(receipt).length ? receipt : undefined);
		}
		case "custom":
			return preserveCustomState ? 0 : clearField(mutableEntry, "data");
		default:
			return 0;
	}
}

/**
 * Release payloads that the latest compaction excludes from the active context.
 *
 * SessionManager.getEntries() returns a shallow array copy whose entry objects
 * remain the manager's resident objects. Mutating only obsolete payload fields
 * therefore releases their strings and images without touching the append-only
 * JSONL file or the id/parentId structure needed by the current branch.
 */
export function pruneCompactedSession(
	sessionManager: ResidentSessionManager,
): ResidentPruneReport {
	const entries = sessionManager.getEntries();
	const active = sessionManager.buildContextEntries();
	const compaction = active.find((entry) => entry.type === "compaction");
	const report: ResidentPruneReport = {
		totalEntries: entries.length,
		activeEntries: active.length,
		prunedEntries: 0,
		estimatedBytesReleased: 0,
		compactionId: compaction?.id,
	};
	const file = sessionManager.getSessionFile();
	if (!compaction || !file || !existsSync(file)) return report;

	const activeIds = new Set(active.map((entry) => entry.id));
	const currentBranchIds = new Set(sessionManager.getBranch().map((entry) => entry.id));

	for (const entry of entries) {
		if (activeIds.has(entry.id)) continue;
		const released = pruneEntryPayload(
			entry,
			entry.type === "custom" && currentBranchIds.has(entry.id),
		);
		if (released <= 0) continue;
		report.prunedEntries++;
		report.estimatedBytesReleased += released;
	}

	return report;
}

/** Restore released payloads in place so existing tree/preparation references remain valid. */
export function restorePrunedSession(sessionManager: ResidentSessionManager): number {
	const file = sessionManager.getSessionFile();
	if (!file) return 0;
	const active = new Set(sessionManager.buildContextEntries().map(entry => entry.id));
	const branch = new Set(sessionManager.getBranch().map(entry => entry.id));
	const candidates = sessionManager.getEntries().filter(entry => {
		if (active.has(entry.id)) return false;
		switch (entry.type) {
			case "message": {
				const message = entry.message as unknown as MutableRecord;
				return (Array.isArray(message.content) && message.content.length === 0)
					|| message.output === "";
			}
			case "compaction":
			case "branch_summary":
				return entry.summary === "";
			case "custom_message":
				return Array.isArray(entry.content) && entry.content.length === 0;
			case "custom":
				return !branch.has(entry.id) && entry.data === undefined;
			default:
				return false;
		}
	});
	if (!candidates.length) return 0;
	const saved = parseSessionEntries(readFileSync(file, "utf8"));
	const header = saved[0];
	if (header?.type !== "session" || header.id !== sessionManager.getSessionId()) {
		throw new Error("The session archive does not match the resident session.");
	}
	const byId = new Map(saved.filter(entry => entry.type !== "session").map(entry => [entry.id, entry]));
	// Validate the complete restoration before changing any resident payload.
	const pairs = candidates.map(entry => {
		const source = byId.get(entry.id);
		if (!source || source.type !== entry.type || source.parentId !== entry.parentId
			|| (entry.type === "message" && source.type === "message"
				&& entry.message.role !== source.message.role)) {
			throw new Error("A released session payload is unavailable in the archive.");
		}
		return [entry, source] as const;
	});
	const restore = (target: MutableRecord, source: MutableRecord, fields: string[]) => {
		for (const field of fields) {
			if (Object.hasOwn(source, field)) target[field] = structuredClone(source[field]);
			else delete target[field];
		}
	};
	for (const [entry, source] of pairs) {
		if (entry.type === "message" && source.type === "message") {
			restore(entry.message as unknown as MutableRecord, source.message as unknown as MutableRecord,
				["content", "output", "details"]);
		} else {
			const fields = entry.type === "custom" ? ["data"]
				: entry.type === "custom_message" ? ["content", "details"] : ["summary", "details"];
			restore(entry as unknown as MutableRecord, source as unknown as MutableRecord, fields);
		}
	}
	return pairs.length;
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function enabledByEnvironment(): boolean {
	const value = process.env.PI_RESIDENT_SESSION_PRUNE?.trim().toLowerCase();
	return value !== "0" && value !== "false" && value !== "off";
}

export default function sessionMemory(pi: ExtensionAPI): void {
	let enabled = enabledByEnvironment();
	let lastReport: ResidentPruneReport | undefined;
	let totalEstimatedBytesReleased = 0;

	const prune = (
		ctx: {
			sessionManager: ResidentSessionManager;
			ui: { notify(message: string, level: "info" | "warning" | "error"): void };
		},
		notify: boolean,
	): ResidentPruneReport => {
		const report = pruneCompactedSession(ctx.sessionManager);
		lastReport = report;
		totalEstimatedBytesReleased += report.estimatedBytesReleased;
		if (notify && report.estimatedBytesReleased >= NOTICE_THRESHOLD_BYTES) {
			ctx.ui.notify(
				`Released about ${formatBytes(report.estimatedBytesReleased)} of compacted session payloads from memory`,
				"info",
			);
		}
		return report;
	};

	pi.on("session_start", (_event, ctx) => {
		if (enabled) prune(ctx, false);
	});

	pi.on("session_compact", (_event, ctx) => {
		if (enabled) prune(ctx, true);
	});

	const restoreBeforeNavigation = (_event: unknown, ctx: ExtensionContext) => {
		try { restorePrunedSession(ctx.sessionManager); }
		catch {
			ctx.ui.notify("Cannot restore released session history. Navigation was cancelled; check the session archive.", "error");
			return { cancel: true };
		}
	};
	pi.on("session_before_tree", restoreBeforeNavigation);
	pi.on("session_before_fork", restoreBeforeNavigation);
	pi.on("session_tree", (_event, ctx) => {
		if (enabled) prune(ctx, false);
	});

	pi.registerCommand("session-memory", {
		description: "Show, run, or toggle compacted-session resident pruning",
		handler: async (args, ctx) => {
			const command = args.trim().toLowerCase();
			if (command === "on" || command === "off") {
				if (command === "off") restorePrunedSession(ctx.sessionManager);
				enabled = command === "on";
				if (enabled) prune(ctx, false);
				ctx.ui.notify(`Resident session pruning ${enabled ? "enabled" : "disabled"}`, "info");
				return;
			}
			if (command === "prune") {
				if (!enabled) {
					ctx.ui.notify("Resident session pruning is disabled", "warning");
					return;
				}
				const report = prune(ctx, false);
				ctx.ui.notify(
					report.compactionId
						? `Pruned ${report.prunedEntries} entries; released about ${formatBytes(report.estimatedBytesReleased)}`
						: "This session has not compacted yet",
					"info",
				);
				return;
			}
			if (command !== "" && command !== "status") {
				ctx.ui.notify("Usage: /session-memory [status|prune|on|off]", "warning");
				return;
			}
			const report = lastReport ?? (enabled ? prune(ctx, false) : undefined);
			ctx.ui.notify(
				[
					`Resident pruning: ${enabled ? "on" : "off"}`,
					report
						? `Entries: ${report.activeEntries} active / ${report.totalEntries} total`
						: "Entries: not inspected",
					`Released this runtime: about ${formatBytes(totalEstimatedBytesReleased)}`,
				].join("\n"),
				"info",
			);
		},
	});
}
