import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Effectiveness tracking for the bundled Pi fixes.
//
// Each fix records an activation whenever it actually prevents its failure
// case (not merely when it is enabled). Over time the report answers the only
// question that matters for a workaround: "is this still needed?" A fix that
// has not fired in a long window is a candidate for removal, exactly the
// signal that would have flagged the now-deleted startup-env helper.
//
// Consumers (the fix extensions) record via a globalThis symbol so they do not
// need to import this module. Persistence is append-only NDJSON of per-flush
// deltas, which is safe across concurrent processes (e.g. subagents).

type FixId = string;

type Store = {
	pending: Map<FixId, number>;
	flushTimer: ReturnType<typeof setTimeout> | undefined;
	exitHookInstalled: boolean;
	record(fixId: FixId, count?: number): void;
	flush(): void;
};

type Agg = { total: number; firstSeen?: string; lastSeen?: string; daily: Map<string, number> };

const GLOBAL_KEY = Symbol.for("pi.fixes.effectiveness");
const BASE_DIR = process.env.PI_FIXES_DIR || join(homedir(), ".pi", "agent", "pi-fixes");
const LOG_FILE = join(BASE_DIR, "effectiveness.ndjson");
const FLUSH_DELAY_MS = 3_000;
const STALE_AFTER_DAYS = 30;

// Fixes this package ships, listed so the report shows a fix even when it has
// never fired — a never-firing fix is the strongest "no longer needed" signal.
const KNOWN_FIXES: Record<FixId, string> = {
	"context-guard-strip": "Oversized single-message strip (context-guard)",
	"claude-effort-remap": "Claude effort lifted to top tier (claude-effort)",
};

function ensureDir(): boolean {
	try {
		mkdirSync(BASE_DIR, { recursive: true });
		return true;
	} catch {
		return false;
	}
}

function getStore(): Store {
	const g = globalThis as typeof globalThis & { [GLOBAL_KEY]?: Store };
	const existing = g[GLOBAL_KEY];
	if (existing) return existing;

	const store: Store = {
		pending: new Map(),
		flushTimer: undefined,
		exitHookInstalled: false,
		record(fixId, count = 1) {
			if (!Number.isFinite(count) || count <= 0) return;
			store.pending.set(fixId, (store.pending.get(fixId) ?? 0) + Math.floor(count));
			if (!store.flushTimer) {
				store.flushTimer = setTimeout(() => {
					store.flushTimer = undefined;
					store.flush();
				}, FLUSH_DELAY_MS);
				store.flushTimer.unref?.();
			}
		},
		flush() {
			if (store.flushTimer) {
				clearTimeout(store.flushTimer);
				store.flushTimer = undefined;
			}
			if (store.pending.size === 0) return;
			if (!ensureDir()) return;
			const ts = new Date().toISOString();
			const pid = process.pid;
			let payload = "";
			for (const [fix, count] of store.pending) {
				if (count > 0) payload += `${JSON.stringify({ ts, pid, fix, count })}\n`;
			}
			try {
				appendFileSync(LOG_FILE, payload, "utf8");
				store.pending.clear();
			} catch {
				// Keep pending counts for a later flush; tracking must never throw
				// into the fix path it is measuring.
			}
		},
	};

	if (!store.exitHookInstalled) {
		store.exitHookInstalled = true;
		try {
			process.on("exit", () => {
				try {
					store.flush();
				} catch {
					// best-effort
				}
			});
		} catch {
			// some embedders disallow process hooks; debounce + session_shutdown still flush
		}
	}

	g[GLOBAL_KEY] = store;
	return store;
}

function aggregate(store: Store): Map<FixId, Agg> {
	const result = new Map<FixId, Agg>();
	const add = (fix: string, ts: string, count: number) => {
		if (count <= 0) return;
		let agg = result.get(fix);
		if (!agg) {
			agg = { total: 0, daily: new Map() };
			result.set(fix, agg);
		}
		agg.total += count;
		if (!agg.firstSeen || ts < agg.firstSeen) agg.firstSeen = ts;
		if (!agg.lastSeen || ts > agg.lastSeen) agg.lastSeen = ts;
		const day = ts.slice(0, 10);
		agg.daily.set(day, (agg.daily.get(day) ?? 0) + count);
	};

	let raw = "";
	try {
		raw = readFileSync(LOG_FILE, "utf8");
	} catch {
		raw = "";
	}
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const rec = JSON.parse(trimmed) as { ts?: unknown; fix?: unknown; count?: unknown };
			if (typeof rec.fix === "string" && typeof rec.ts === "string" && typeof rec.count === "number") {
				add(rec.fix, rec.ts, rec.count > 0 ? Math.floor(rec.count) : 0);
			}
		} catch {
			// skip a malformed line rather than failing the whole report
		}
	}

	// Fold in not-yet-flushed in-memory counts so the report is always current.
	const nowIso = new Date().toISOString();
	for (const [fix, count] of store.pending) add(fix, nowIso, count);
	return result;
}

function countWithinDays(agg: Agg, days: number, now: number): number {
	const cutoff = now - days * 86_400_000;
	let sum = 0;
	for (const [day, n] of agg.daily) {
		const t = Date.parse(`${day}T23:59:59Z`);
		if (Number.isFinite(t) && t >= cutoff) sum += n;
	}
	return sum;
}

function timeAgo(iso: string | undefined, now: number): string {
	if (!iso) return "never";
	const t = Date.parse(iso);
	if (!Number.isFinite(t)) return "unknown";
	const seconds = Math.max(0, Math.floor((now - t) / 1000));
	if (seconds < 60) return `${seconds}s ago`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.floor(hours / 24)}d ago`;
}

function report(): string {
	const now = Date.now();
	const aggs = aggregate(getStore());
	const ids = [...Object.keys(KNOWN_FIXES), ...[...aggs.keys()].filter((id) => !(id in KNOWN_FIXES))];
	const lines: string[] = ["pi-fixes effectiveness — is each fix still preventing its failure?", `log: ${LOG_FILE}`, ""];

	for (const id of ids) {
		const label = KNOWN_FIXES[id] ?? id;
		const agg = aggs.get(id);
		const total = agg?.total ?? 0;
		const last7 = agg ? countWithinDays(agg, 7, now) : 0;
		const last30 = agg ? countWithinDays(agg, STALE_AFTER_DAYS, now) : 0;

		let verdict: string;
		if (total === 0) verdict = "UNUSED — never fired since tracking began; candidate for removal";
		else if (last30 === 0) verdict = `REVIEW — last fired ${timeAgo(agg?.lastSeen, now)}; no activations in ${STALE_AFTER_DAYS}d, candidate for removal`;
		else verdict = `NEEDED — active (last ${timeAgo(agg?.lastSeen, now)})`;

		lines.push(`• ${label}`);
		lines.push(`    id: ${id}`);
		lines.push(`    total: ${total}   last 7d: ${last7}   last ${STALE_AFTER_DAYS}d: ${last30}`);
		lines.push(`    first seen: ${agg?.firstSeen ?? "—"}   last seen: ${agg?.lastSeen ?? "—"}`);
		lines.push(`    ${verdict}`);
		lines.push("");
	}

	return lines.join("\n").trimEnd();
}

// Create the store at module load so the fix extensions can record immediately.
getStore();

export default function effectiveness(pi: ExtensionAPI) {
	getStore();

	pi.on("session_shutdown", async () => {
		getStore().flush();
	});

	pi.registerCommand("pi-fixes", {
		description: "Report whether each bundled Pi fix is still firing (effectiveness tracking)",
		handler: async (args, ctx) => {
			const input = args.trim().toLowerCase();
			if (input === "flush") {
				getStore().flush();
				ctx.ui.notify(`pi-fixes: flushed effectiveness counters to ${LOG_FILE}`, "info");
				return;
			}
			ctx.ui.notify(report(), "info");
		},
	});
}
