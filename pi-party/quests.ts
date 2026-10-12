import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { defaultHours, isOnDuty, localTime, QUEST_KINDS, type Quest, type QuestActor, type QuestCommand, type QuestEvent, type QuestHours, type QuestKind, type QuestStep, type QuestView } from "./quest-model.ts";

const MAX_OPEN = 200;
const text = (value: unknown, limit: number, name: string) => {
	if (typeof value !== "string" || !value.trim()) throw Error(`Give the quest a ${name}.`);
	return value.trim().slice(0, limit);
};
const optionalText = (value: unknown, limit: number) => typeof value === "string" && value.trim() ? value.trim().slice(0, limit) : undefined;
const kind = (value: unknown): QuestKind | undefined => {
	if (value === undefined) return;
	if (!QUEST_KINDS.includes(value as QuestKind)) throw Error(`A quest kind is one of ${QUEST_KINDS.join(", ")}.`);
	return value as QuestKind;
};
const date = (value: unknown) => {
	if (value === undefined || value === null || value === "") return undefined;
	if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value))) throw Error("Give due dates as YYYY-MM-DD.");
	return value;
};
const steps = (value: unknown): QuestStep[] | undefined => {
	if (value === undefined) return;
	if (!Array.isArray(value) || value.length > 30) throw Error("Steps are a list of up to 30 items.");
	return value.map(step => typeof step === "string" ? { title: text(step, 300, "step") }
		: { title: text((step as QuestStep)?.title, 300, "step"), done: (step as QuestStep)?.done === true }).map(step => ({ done: false, ...step }));
};

/**
 * One computer's quest log, in the agent database so Desk, its agents' workers and the Dot connector share it.
 * Every change is an event; readers ask what changed since their last look.
 */
export class QuestStore {
	private db: DatabaseSync;
	private directory: string;
	private timeZone: string;
	constructor(directory: string, timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
		this.directory = directory; this.timeZone = timeZone;
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		this.db = new DatabaseSync(join(directory, "party.sqlite"));
		this.db.exec(`PRAGMA busy_timeout=5000;
			CREATE TABLE IF NOT EXISTS quests (id TEXT PRIMARY KEY, title TEXT NOT NULL, notes TEXT, kind TEXT NOT NULL, state TEXT NOT NULL,
				due TEXT, steps TEXT, source TEXT NOT NULL, notify INTEGER NOT NULL DEFAULT 0, position REAL NOT NULL,
				created INTEGER NOT NULL, updated INTEGER NOT NULL, completed INTEGER);
			CREATE TABLE IF NOT EXISTS quest_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, actor TEXT NOT NULL,
				action TEXT NOT NULL, quest TEXT NOT NULL, title TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS quest_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
	}
	close(): void { this.db.close(); }
	private notify(): void {
		try { writeFileSync(join(this.directory, "changed"), randomBytes(8).toString("hex"), { mode: 0o600 }); }
		catch { /* Desk's periodic refresh also reads the log. */ }
	}
	private tx<T>(work: () => T): T {
		this.db.exec("BEGIN IMMEDIATE");
		try { const value = work(); this.db.exec("COMMIT"); return value; }
		catch (error) { this.db.exec("ROLLBACK"); throw error; }
	}
	private meta(key: string): string | undefined {
		return (this.db.prepare("SELECT value FROM quest_meta WHERE key=?").get(key) as { value: string } | undefined)?.value;
	}
	private setMeta(key: string, value: string): void {
		this.db.prepare("INSERT INTO quest_meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
	}
	private row(value: Record<string, unknown> | undefined): Quest | undefined {
		if (!value) return;
		return { id: String(value.id), title: String(value.title), ...(value.notes ? { notes: String(value.notes) } : {}), kind: value.kind as QuestKind,
			state: value.state as Quest["state"], ...(value.due ? { due: String(value.due) } : {}), ...(value.steps ? { steps: JSON.parse(String(value.steps)) } : {}),
			source: JSON.parse(String(value.source)), ...(value.notify ? { notify: true } : {}), created: Number(value.created), updated: Number(value.updated),
			...(value.completed ? { completed: Number(value.completed) } : {}) };
	}
	get(id: string): Quest | undefined { return this.row(this.db.prepare("SELECT * FROM quests WHERE id=?").get(id) as Record<string, unknown> | undefined); }
	private require(id: unknown): Quest {
		const quest = typeof id === "string" ? this.get(id) : undefined;
		if (!quest) throw Error(`No quest has the id ${String(id)}. Read the log for current ids.`);
		return quest;
	}
	private event(by: QuestActor, action: QuestEvent["action"], quest: Quest): void {
		this.db.prepare("INSERT INTO quest_events (at,actor,action,quest,title) VALUES (?,?,?,?,?)").run(Date.now(), JSON.stringify(by), action, quest.id, quest.title);
		this.db.prepare("DELETE FROM quest_events WHERE seq < (SELECT MAX(seq) - 500 FROM quest_events)").run();
	}
	/** A stable agent identity the host uses to message agents about their quests. */
	service(): { session: string; owner: string } {
		const saved = this.meta("service");
		if (saved) return JSON.parse(saved);
		const value = { session: crypto.randomUUID(), owner: crypto.randomUUID() };
		this.setMeta("service", JSON.stringify(value)); return value;
	}
	hours(): QuestHours {
		const saved = this.meta("hours");
		return { ...defaultHours(this.timeZone), ...(saved ? JSON.parse(saved) : {}), timeZone: this.timeZone };
	}
	revision(): number { return Number((this.db.prepare("SELECT MAX(seq) AS seq FROM quest_events").get() as { seq: number | null }).seq ?? 0); }

	view(at = Date.now()): QuestView {
		const hours = this.hours(), today = localTime(at, hours.timeZone).date;
		const rows = this.db.prepare("SELECT * FROM quests WHERE state='open' OR state='done' AND completed>? ORDER BY state='done', position, created")
			.all(at - 36 * 3_600_000) as Record<string, unknown>[];
		const quests = rows.map(row => this.row(row)!).filter(quest => quest.state === "open" || localTime(quest.completed!, hours.timeZone).date === today);
		const days = new Set<string>();
		for (const row of this.db.prepare("SELECT completed FROM quests WHERE state='done' AND completed>? ORDER BY completed DESC").all(at - 400 * 86_400_000) as { completed: number }[])
			days.add(localTime(row.completed, hours.timeZone).date);
		return { quests, hours, today, onDuty: isOnDuty(hours, at), completedDays: [...days], revision: this.revision() };
	}

	/** Changes made by others since this reader's last look, and whether anything changed at all. Moves the reader's mark. */
	changesSince(reader: string, others: (actor: QuestActor) => boolean): { changed: boolean; events: QuestEvent[] } {
		const key = `seen:${reader}`, seen = Number(this.meta(key) ?? 0), revision = this.revision();
		const events = (this.db.prepare("SELECT * FROM quest_events WHERE seq>? ORDER BY seq LIMIT 100").all(seen) as Record<string, unknown>[])
			.map(row => ({ seq: Number(row.seq), at: Number(row.at), by: JSON.parse(String(row.actor)), action: row.action as QuestEvent["action"], quest: String(row.quest), title: String(row.title) }))
			.filter(event => others(event.by));
		this.setMeta(key, String(revision));
		return { changed: revision > seen, events };
	}

	/** Apply one change. Agents may only change quests they added; returns the quest for any follow-up. */
	apply(by: QuestActor, command: QuestCommand, options: { notify?: boolean } = {}): Quest | undefined {
		const result = this.tx(() => {
			const now = Date.now();
			const own = (quest: Quest) => {
				if (by.kind === "agent" && !(quest.source.kind === "agent" && quest.source.id === by.id))
					throw Error("Agents can only change quests they added. Message Jordan or his Dot about others.");
				return quest;
			};
			switch (command.action) {
				case "add": {
					const open = (this.db.prepare("SELECT COUNT(*) AS n FROM quests WHERE state='open'").get() as { n: number }).n;
					if (open >= MAX_OPEN) throw Error("The quest log is full. Complete or abandon some quests first.");
					const first = (this.db.prepare("SELECT MIN(position) AS p FROM quests WHERE state='open'").get() as { p: number | null }).p;
					const last = (this.db.prepare("SELECT MAX(position) AS p FROM quests WHERE state='open'").get() as { p: number | null }).p;
					const quest: Quest = { id: randomBytes(3).toString("hex"), title: text(command.title, 200, "title"), kind: kind(command.kind) ?? "side", state: "open",
						notes: optionalText(command.notes, 4000), due: date(command.due), steps: steps(command.steps), source: by,
						...(by.kind === "agent" && options.notify !== false ? { notify: true } : {}), created: now, updated: now };
					// Jordan's own quests go to the top; others' at the bottom.
					const position = by.kind === "you" ? (first ?? 0) - 1 : (last ?? 0) + 1;
					this.db.prepare("INSERT INTO quests VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)").run(quest.id, quest.title, quest.notes ?? null, quest.kind, "open",
						quest.due ?? null, quest.steps ? JSON.stringify(quest.steps) : null, JSON.stringify(quest.source), quest.notify ? 1 : 0, position, now, now, null);
					this.event(by, "added", quest); return quest;
				}
				case "update": {
					const quest = own(this.require(command.id));
					const next: Quest = { ...quest, updated: now,
						...(command.title !== undefined ? { title: text(command.title, 200, "title") } : {}),
						...(command.kind !== undefined ? { kind: kind(command.kind)! } : {}),
						...(command.notes !== undefined ? { notes: optionalText(command.notes, 4000) } : {}),
						...(command.due !== undefined ? { due: date(command.due) } : {}),
						...(command.steps !== undefined ? { steps: steps(command.steps) } : {}) };
					this.db.prepare("UPDATE quests SET title=?,notes=?,kind=?,due=?,steps=?,updated=? WHERE id=?").run(next.title, next.notes ?? null, next.kind,
						next.due ?? null, next.steps?.length ? JSON.stringify(next.steps) : null, now, quest.id);
					this.event(by, "updated", next); return next;
				}
				case "complete": case "abandon": case "reopen": {
					const quest = own(this.require(command.id));
					const state = command.action === "complete" ? "done" : command.action === "abandon" ? "abandoned" : "open";
					if (quest.state === state) return quest;
					this.db.prepare("UPDATE quests SET state=?,completed=?,updated=? WHERE id=?").run(state, state === "done" ? now : null, now, quest.id);
					const next = { ...quest, state, ...(state === "done" ? { completed: now } : { completed: undefined }), updated: now } as Quest;
					this.event(by, command.action === "complete" ? "completed" : command.action === "abandon" ? "abandoned" : "reopened", next); return next;
				}
				case "move": {
					const quest = own(this.require(command.id));
					const before = command.before ? this.require(command.before) : undefined;
					const positions = (this.db.prepare("SELECT id, position FROM quests WHERE state='open' ORDER BY position, created").all() as { id: string; position: number }[])
						.filter(row => row.id !== quest.id);
					const index = before ? positions.findIndex(row => row.id === before.id) : positions.length;
					const after = positions[index - 1]?.position, next = positions[index]?.position;
					const position = after === undefined ? (next ?? 0) - 1 : next === undefined ? after + 1 : (after + next) / 2;
					this.db.prepare("UPDATE quests SET position=?,updated=? WHERE id=?").run(position, now, quest.id);
					this.event(by, "moved", quest); return quest;
				}
				case "hours": {
					if (by.kind !== "you") throw Error("Only Jordan sets his working hours.");
					const current = this.hours(), hours = { ...current, ...command.hours };
					if (!Array.isArray(hours.days) || hours.days.some(day => !Number.isInteger(day) || day < 0 || day > 6)
						|| !Number.isInteger(hours.start) || !Number.isInteger(hours.end) || hours.start < 0 || hours.end > 24 || hours.start >= hours.end)
						throw Error("Working hours need days 0–6 and whole start and end hours, start before end.");
					this.setMeta("hours", JSON.stringify({ days: [...new Set(hours.days)].sort(), start: hours.start, end: hours.end }));
					this.db.prepare("INSERT INTO quest_events (at,actor,action,quest,title) VALUES (?,?,?,?,?)").run(now, JSON.stringify(by), "updated", "", "Working hours");
					return;
				}
				default: throw Error("Unknown quest action.");
			}
		});
		this.notify();
		return result;
	}
}
