import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { dayOf, live, type Entry, type State } from "./domain.ts";

/** The prompt section's tag: Pi wraps the text in <conversation_handbook>. */
export const SECTION_TAG = "conversation_handbook";
/** The most of the handbook the prompt carries, in characters (about 3,000 tokens); the rest is read with the tool. */
export const SECTION_LIMIT = 12_000;
/** Active entries the tidy-up keeps the handbook under, by merging and retiring. */
export const ENTRY_LIMIT = 60;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const shortDate = (time: number) => { const date = new Date(time); return date.getDate() + " " + MONTHS[date.getMonth()] + " " + date.getFullYear(); };
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
export const sentence = (text: string) => { const line = oneLine(text); return /[.!?]$/.test(line) ? line : line + "."; };

/** Instructions first (pinned, then oldest first), then learnings (pinned, then most recently used). */
export function ranked(state: State): Entry[] {
	const entries = [...state.entries.values()].filter(entry => entry.status === "active");
	const instructions = entries.filter(entry => entry.kind === "instruction")
		.sort((a, b) => Number(b.pinned) - Number(a.pinned) || (a.sourceAt ?? a.addedAt) - (b.sourceAt ?? b.addedAt));
	const learnings = entries.filter(entry => entry.kind === "learning")
		.sort((a, b) => Number(b.pinned) - Number(a.pinned) || (b.lastUse ?? b.addedAt) - (a.lastUse ?? a.addedAt));
	return [...instructions, ...learnings];
}

/** One entry as the model reads it. A flagged entry carries the flag's reason until a tidy-up pass settles it. */
export function entryLine(entry: Entry): string {
	const conditions = entry.holdsWhile ? " Holds while: " + sentence(entry.holdsWhile) : "";
	const pointers = entry.pointsTo?.length ? " See: " + entry.pointsTo.map(pointer => "`" + pointer + "`").join(", ") : "";
	const flagged = entry.flag ? " (Flagged as wrong or out of date" + (entry.flag.reason ? ": " + oneLine(entry.flag.reason) : "") + ")" : "";
	if (entry.kind === "instruction")
		return "- " + entry.id + ", " + shortDate(entry.sourceAt ?? entry.addedAt) + (entry.text ? " (" + oneLine(entry.text) + ")" : "")
			+ ": \"" + oneLine(entry.quote ?? entry.text) + "\"" + conditions + pointers + flagged;
	return "- " + entry.id + ": " + oneLine(entry.text) + conditions + pointers + flagged;
}

const GUIDE = "This conversation's handbook carries forward what its kind of work needs. Instructions quote the user's own words, "
	+ "with the date they gave them; a newer message from the user overrides any of them. Learnings are what this conversation "
	+ "found out; check one against the current state before relying on it. Use the handbook tool to add an entry, or to flag one "
	+ "that is wrong or out of date.";

/** The prompt section, or "" when the handbook is empty. At most limit characters; the rest is listed by count. */
export function sectionText(state: State, limit = SECTION_LIMIT): string {
	const entries = ranked(state);
	if (!state.purpose && !entries.length) return "";
	const head = ["Purpose: " + (state.purpose ? oneLine(state.purpose.text) : "not written yet."), GUIDE];
	const lines: string[] = [];
	let size = head.join("\n").length, left = 0, kind = "";
	for (const entry of entries) {
		const line = entryLine(entry), heading = entry.kind !== kind ? (entry.kind === "instruction" ? "Instructions:" : "Learnings:") : "";
		if (size + line.length + heading.length + 2 > limit) { left++; continue; }
		if (heading) { lines.push(heading); kind = entry.kind; size += heading.length + 1; }
		lines.push(line); size += line.length + 1;
	}
	if (left) lines.push("(" + left + " more entr" + (left === 1 ? "y" : "ies") + " not shown here: read them with the handbook tool's read action.)");
	return [...head, ...lines].join("\n");
}

/** The whole handbook as text, for the tool's read action and the terminal. */
export function fullText(state: State): string {
	const entries = ranked(state), pending = [...state.entries.values()].filter(entry => entry.status === "pending");
	return [
		"Purpose: " + (state.purpose?.text ?? "not written yet."),
		...(entries.length ? ["Instructions and learnings:", ...entries.map(entryLine)] : ["No entries yet."]),
		...(pending.length ? ["Waiting for the next tidy-up:", ...pending.map(entryLine)] : []),
	].join("\n");
}

/** A local file an entry points to, or undefined for an address or a relative name. */
export function localPath(pointer: string, cwd: string): string | undefined {
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(pointer)) return;
	const path = pointer.startsWith("~/") ? join(homedir(), pointer.slice(2)) : pointer;
	return isAbsolute(path) ? path : pointer.startsWith("./") || pointer.startsWith("../") ? join(cwd, path) : undefined;
}
/** The pointers of an entry that name local files that no longer exist. */
export function missingPointers(entry: Entry, cwd: string): string[] {
	return (entry.pointsTo ?? []).filter(pointer => { const path = localPath(pointer, cwd); return !!path && !existsSync(path); });
}

export interface ViewStatus {
	running?: string;
	error?: string;
	nextPass?: number;
	model?: string;
	/** Whether the conversation has history from before the handbook arrived that no pass has read. */
	unread: boolean;
	sectionChars: number;
}

/** The plain data Desk's handbook view draws. */
export function viewData(state: State, status: ViewStatus, cwd: string) {
	const entry = (item: Entry) => ({
		id: item.id, kind: item.kind, text: item.text, quote: item.quote ?? null, holdsWhile: item.holdsWhile ?? null,
		pointsTo: item.pointsTo ?? [], missing: live(item) ? missingPointers(item, cwd) : [], status: item.status,
		pinned: item.pinned, protected: item.protected, reviewed: item.reviewed, sourceAt: item.sourceAt ?? null, sources: item.sources.length,
		addedAt: item.addedAt, addedBy: item.addedBy, endedAt: item.endedAt ?? null, endedBy: item.endedBy ?? null,
		endReason: item.endReason ?? null, replacedBy: item.replacedBy ?? null,
		flag: item.flag ? { reason: item.flag.reason, at: item.flag.at, by: item.flag.by,
			proposal: item.flag.proposal ? item.flag.proposal.quote ?? item.flag.proposal.text : null } : null,
		cameUp: item.cameUp, misled: item.misled, repeated: item.repeated, lastUse: item.lastUse ?? null,
	});
	const days = new Map<string, { day: string; messages: number; instructions: number; corrections: number; repeats: number; changes: number }>();
	const day = (key: string) => { let row = days.get(key); if (!row) days.set(key, row = { day: key, messages: 0, instructions: 0, corrections: 0, repeats: 0, changes: 0 }); return row; };
	for (const { label, day: key } of state.labels.values()) {
		const row = day(key); row.messages++;
		if (label === "instruction") row.instructions++; else if (label === "correction") row.corrections++; else if (label === "repeat") row.repeats++;
	}
	for (const [key, count] of state.changes) day(key).changes += count;
	const today = dayOf(Date.now()), order = new Map(ranked(state).map((item, index) => [item.id, index]));
	return {
		purpose: state.purpose ? { text: state.purpose.text, at: state.purpose.at, by: state.purpose.by } : null,
		// Every live entry, in the prompt's order, and the 100 that ended last.
		entries: [...[...state.entries.values()].filter(live).sort((a, b) => (order.get(a.id) ?? order.size) - (order.get(b.id) ?? order.size)),
			...[...state.entries.values()].filter(item => !live(item))
			.sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0)).slice(0, 100)].map(entry),
		log: state.log.slice(-300).reverse().map(item => ({ at: item.at, actor: item.actor, id: item.id ?? null, text: item.text, reason: item.reason ?? null, was: item.was ?? null })),
		days: [...days.values()].filter(row => row.day <= today).sort((a, b) => a.day.localeCompare(b.day)).slice(-120),
		passes: state.passes.slice(-10).map(pass => ({ at: pass.at, model: pass.model, cost: pass.cost, messages: pass.messages, error: pass.error ?? null })),
		status: { running: status.running ?? null, error: status.error ?? null, nextPass: status.nextPass ?? null, model: status.model ?? null,
			unread: status.unread, sectionChars: status.sectionChars, sectionLimit: SECTION_LIMIT, entryLimit: ENTRY_LIMIT },
	};
}
