/**
 * A conversation's handbook: its purpose, the user's lasting instructions in their own words, and what the
 * conversation has learned about doing its kind of work. It is stored as changes in the session (custom entries on
 * the branch), and this module folds them into the current state. Every change is a list of operations on single
 * entries, so the history of each entry stays readable and nothing is rewritten wholesale.
 */
export const CHANGE_ENTRY = "pi-handbook/change-v1";
/** The section text the model was last given, so a restarted process gives the same text until the cache breaks. */
export const PUBLISHED_ENTRY = "pi-handbook/published-v1";

export type Kind = "instruction" | "learning";
export type Actor = "agent" | "tidy" | "user";
export type Status = "active" | "pending" | "replaced" | "retired" | "removed" | "rejected";
export type Ended = Exclude<Status, "active" | "pending">;
export type Label = "instruction" | "correction" | "repeat" | "other";
export const LABELS: readonly Label[] = ["instruction", "correction", "repeat", "other"];

/** An entry as proposed: by the agent's tool, the tidy-up or the user. */
export interface Draft {
	kind: Kind;
	/** A learning itself; for an instruction, what it is about (optional). */
	text: string;
	/** An instruction's words, exactly as the user wrote them. */
	quote?: string;
	/** Session entry IDs the entry rests on: the user's message for an instruction. */
	sources: string[];
	/** When the main source was written, in ms since the epoch. */
	sourceAt?: number;
	/** The conditions it rests on: when they change, the entry needs review. */
	holdsWhile?: string;
	/** Files or addresses it refers to. */
	pointsTo?: string[];
	protected?: boolean;
}
export interface Entry extends Draft {
	id: string;
	status: Status;
	pinned: boolean;
	protected: boolean;
	addedAt: number;
	addedBy: Actor;
	/** False for an instruction the agent added that the tidy-up has not yet seen. */
	reviewed: boolean;
	endedAt?: number;
	endedBy?: Actor;
	endReason?: string;
	replacedBy?: string;
	flag?: { reason: string; at: number; by: Actor; proposal?: Draft };
	/** Tidy-up passes in which the work touched the entry's subject. */
	cameUp: number;
	/** Times the agent followed it and the user corrected that. */
	misled: number;
	/** Times the user had to say it again. */
	repeated: number;
	lastUse?: number;
}

type Body =
	| { op: "start"; from: string | null }
	| { op: "add"; id: string; entry: Draft; status: "active" | "pending" }
	| { op: "edit"; id: string; text?: string; quote?: string; holdsWhile?: string | null; pointsTo?: string[] | null }
	| { op: "end"; id: string; status: Ended; by?: string }
	| { op: "admit"; id: string }
	| { op: "flag"; id: string; proposal?: Draft }
	| { op: "unflag"; id: string }
	| { op: "pin"; id: string; pinned: boolean }
	| { op: "review"; ids: string[] }
	| { op: "usage"; id: string; cameUp?: boolean; misled?: boolean; repeated?: boolean }
	| { op: "purpose"; text: string }
	| { op: "propose-purpose"; text: string }
	| { op: "dismiss-purpose" }
	/** [message entry ID, label, local day] for each of the user's messages a pass read. */
	| { op: "labels"; labels: [string, Label, string][] }
	/** The user's messages are read through this entry; null starts again from the beginning. */
	| { op: "cover"; through: string | null }
	/** A tidy-up pass: more is set when messages were left for the next pass. */
	| { op: "pass"; model: string; cost: number; messages: number; more?: boolean; error?: string };
export type Op = Body & { reason?: string };
export interface Change { v: 1; at: number; actor: Actor; ops: Op[] }

export interface Pass { at: number; model: string; cost: number; messages: number; more?: boolean; error?: string }
/** A change, in words. `was` is the purpose a change of purpose replaced, which the user can restore. */
export interface LogItem { at: number; actor: Actor; id?: string; text: string; reason?: string; was?: string }
export interface State {
	/** Where reading began: null from the start, an entry ID when the handbook arrived in an existing conversation. */
	from?: string | null;
	/** The last entry whose messages a pass has read; null or undefined when none has. */
	covered?: string | null;
	purpose?: { text: string; at: number; by: Actor };
	proposedPurpose?: { text: string; at: number; by: Actor; reason?: string };
	entries: Map<string, Entry>;
	next: { i: number; l: number };
	labels: Map<string, { label: Label; day: string }>;
	/** Handbook changes per local day, for the chart. */
	changes: Map<string, number>;
	passes: Pass[];
	log: LogItem[];
	/** The last change's time. */
	updatedAt?: number;
}

export function emptyState(): State {
	return { entries: new Map(), next: { i: 1, l: 1 }, labels: new Map(), changes: new Map(), passes: [], log: [] };
}

/** The local calendar day of a time, as YYYY-MM-DD. */
export function dayOf(time: number): string {
	const date = new Date(time);
	return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-");
}

/** Text as compared for quotes and duplicates: case, spacing and quote marks ignored. */
export function normal(text: string): string {
	return text.replace(/[\u2018\u2019\u2032]/g, "'").replace(/[\u201c\u201d\u2033]/g, "\"").replace(/\s+/g, " ").trim().toLowerCase();
}

const WORD = /[\p{L}\p{N}]/u;
/**
 * Whether text holds quote word for word, as compared by normal(): the match must not start or end inside a word,
 * so a quote cut mid-word ("to be clea") is refused.
 */
export function quotes(text: string, quote: string): boolean {
	const haystack = normal(text), needle = normal(quote);
	if (!needle) return false;
	for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + 1)) {
		const before = haystack[at - 1], after = haystack[at + needle.length];
		const starts = !before || !WORD.test(before) || !WORD.test(needle[0]!), ends = !after || !WORD.test(after) || !WORD.test(needle.at(-1)!);
		if (starts && ends) return true;
	}
	return false;
}

/**
 * "Never", "don't" or "do not" as a command (at the start of a clause, or after "please", "and" and the like), "I don't
 * want", or "must not" and "should not". "We don't need time limits" states no prohibition, and is left unprotected.
 */
const PROHIBITION = new RegExp([
	String.raw`(?:^|[.!?;:,\n]\s*|\b(?:please|and|but|so|also|just|then|ok|okay|yes|no)\s+)(?:never|don['\u2019]?t|do\s+not)\b`,
	String.raw`\bI\s+(?:never|don['\u2019]?t|do\s+not)\s+want\b`,
	String.raw`\b(?:must|should|shall)\s+(?:not|never)\b|\b(?:mustn|shouldn)['\u2019]?t\b`,
].join("|"), "i");
/** A prohibition is protected: only the user can remove or change it. */
export function prohibits(quote: string | undefined): boolean { return !!quote && PROHIBITION.test(quote); }

const short = (text: string, length = 90) => {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > length ? line.slice(0, length - 1) + "…" : line;
};
const label = (entry: Pick<Entry, "kind" | "text" | "quote">) => entry.kind === "instruction" && entry.quote ? "\"" + short(entry.quote) + "\"" : short(entry.text);

function decode(data: unknown): Change | undefined {
	const change = data as Change | undefined;
	return change && change.v === 1 && Array.isArray(change.ops) && typeof change.at === "number" ? change : undefined;
}

/** Applies one change to the state. Operations on entries that do not exist, or no longer accept them, are skipped. */
export function applyChange(state: State, change: Change): void {
	const { at, actor } = change;
	let counted = 0;
	const log = (text: string, op: Op, id?: string, was?: string) => {
		state.log.push({ at, actor, ...(id ? { id } : {}), text, ...(op.reason ? { reason: op.reason } : {}), ...(was ? { was } : {}) });
		counted++;
	};
	for (const op of change.ops) {
		const entry = "id" in op ? state.entries.get(op.id) : undefined;
		switch (op.op) {
			case "start": state.from ??= op.from; if (state.covered === undefined) state.covered = op.from; break;
			case "add": {
				if (state.entries.has(op.id) || !op.entry || (op.entry.kind !== "instruction" && op.entry.kind !== "learning")) break;
				const number = Number(op.id.slice(1));
				if (Number.isSafeInteger(number)) {
					const kind = op.entry.kind === "instruction" ? "i" : "l";
					state.next[kind] = Math.max(state.next[kind], number + 1);
				}
				state.entries.set(op.id, {
					...op.entry, id: op.id, status: op.status, pinned: false,
					protected: !!op.entry.protected || prohibits(op.entry.quote), addedAt: at, addedBy: actor,
					reviewed: actor !== "agent" || op.entry.kind !== "instruction", cameUp: 0, misled: 0, repeated: 0,
				});
				log((op.status === "pending" ? "Noted " : "Added ") + (op.entry.kind === "instruction" ? "instruction " : "learning ") + op.id
					+ (op.status === "pending" ? " for review: " : ": ") + label(op.entry), op, op.id);
				break;
			}
			case "edit": {
				if (!entry || (entry.status !== "active" && entry.status !== "pending")) break;
				if (op.text !== undefined) entry.text = op.text;
				if (op.quote !== undefined && entry.kind === "instruction") entry.quote = op.quote;
				if (op.holdsWhile !== undefined) { if (op.holdsWhile === null) delete entry.holdsWhile; else entry.holdsWhile = op.holdsWhile; }
				if (op.pointsTo !== undefined) { if (op.pointsTo === null) delete entry.pointsTo; else entry.pointsTo = op.pointsTo; }
				log("Reworded " + op.id + ": " + label(entry), op, op.id);
				break;
			}
			case "end": {
				if (!entry || (entry.status !== "active" && entry.status !== "pending")) break;
				entry.status = op.status; entry.endedAt = at; entry.endedBy = actor;
				if (op.reason) entry.endReason = op.reason;
				if (op.by) entry.replacedBy = op.by;
				delete entry.flag;
				log(op.status === "replaced" ? "Replaced " + op.id + (op.by ? " with " + op.by : "")
					: op.status === "retired" ? "Retired " + op.id : op.status === "rejected" ? "Turned down " + op.id : "Removed " + op.id, op, op.id);
				break;
			}
			case "admit":
				if (entry?.status !== "pending") break;
				entry.status = "active"; entry.reviewed = true;
				log("Admitted " + op.id + ": " + label(entry), op, op.id);
				break;
			case "flag":
				if (!entry || (entry.status !== "active" && entry.status !== "pending")) break;
				entry.flag = { reason: op.reason ?? "", at, by: actor, ...(op.proposal ? { proposal: op.proposal } : {}) };
				log("Flagged " + op.id + " for review", op, op.id);
				break;
			case "unflag":
				if (!entry?.flag) break;
				delete entry.flag;
				log("Kept " + op.id + " as it is", op, op.id);
				break;
			case "pin":
				if (!entry || entry.pinned === op.pinned) break;
				entry.pinned = op.pinned;
				log((op.pinned ? "Pinned " : "Unpinned ") + op.id, op, op.id);
				break;
			case "review":
				for (const id of op.ids) { const item = state.entries.get(id); if (item) item.reviewed = true; }
				break;
			case "usage":
				if (!entry) break;
				if (op.cameUp) { entry.cameUp++; entry.lastUse = at; }
				if (op.misled) entry.misled++;
				if (op.repeated) entry.repeated++;
				break;
			case "purpose": {
				const text = op.text.trim(), was = state.purpose?.text;
				if (!text || text === was) break;
				state.purpose = { text, at, by: actor };
				delete state.proposedPurpose;
				log(actor === "user" ? "Set the purpose" : was ? "Changed the purpose" : "Wrote the purpose", op, undefined, was);
				break;
			}
			case "propose-purpose":
				if (!op.text.trim()) break;
				state.proposedPurpose = { text: op.text.trim(), at, by: actor, ...(op.reason ? { reason: op.reason } : {}) };
				log("Proposed a new purpose", op);
				break;
			case "dismiss-purpose":
				if (!state.proposedPurpose) break;
				delete state.proposedPurpose;
				log("Kept the purpose as it is", op);
				break;
			case "labels":
				for (const [id, kind, day] of op.labels) if (typeof id === "string" && LABELS.includes(kind)) state.labels.set(id, { label: kind, day });
				break;
			case "cover":
				state.covered = op.through;
				// Reading again from the start reads the history from before the handbook arrived too.
				if (op.through === null) state.from = null;
				break;
			case "pass":
				state.passes.push({ at, model: op.model, cost: op.cost, messages: op.messages, ...(op.more ? { more: true } : {}), ...(op.error ? { error: op.error } : {}) });
				if (state.passes.length > 50) state.passes.shift();
				state.log.push({ at, actor, text: op.error ? "Tidy-up failed: " + op.error
					: "Tidy-up read " + op.messages + " message" + (op.messages === 1 ? "" : "s") + (op.cost ? " (" + (op.cost < 0.005 ? "under $0.01" : "$" + op.cost.toFixed(2)) + " at API prices)" : "") });
				break;
		}
	}
	if (counted) state.changes.set(dayOf(at), (state.changes.get(dayOf(at)) ?? 0) + counted);
	state.updatedAt = at;
}

type BranchEntry = { type: string; customType?: string; data?: unknown };
/** The handbook as the branch's changes leave it. */
export function foldBranch(branch: readonly BranchEntry[]): State {
	const state = emptyState();
	for (const entry of branch) {
		if (entry.type !== "custom" || entry.customType !== CHANGE_ENTRY) continue;
		const change = decode(entry.data);
		if (change) applyChange(state, change);
	}
	return state;
}

/** The section text the model was last given on this branch, if any. */
export function lastPublished(branch: readonly BranchEntry[]): string | undefined {
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index]!;
		if (entry.type === "custom" && entry.customType === PUBLISHED_ENTRY) {
			const text = (entry.data as { text?: unknown } | undefined)?.text;
			return typeof text === "string" ? text : undefined;
		}
	}
}

export const live = (entry: Entry) => entry.status === "active" || entry.status === "pending";

/**
 * Days the conversation was used (the user wrote in it) after a time, counted from the messages the tidy-up has read.
 * Learnings that go this many days without coming up are retired.
 */
export function daysUsedSince(state: State, time: number): number {
	const after = dayOf(time), days = new Set<string>();
	for (const { day } of state.labels.values()) if (day > after) days.add(day);
	return days.size;
}
