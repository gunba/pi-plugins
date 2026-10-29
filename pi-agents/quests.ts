import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { defaultHours, isOnDuty, isReady, lastDue, localTime, nextDue, QUEST_KINDS, type Quest, type QuestActor, type QuestCommand, type QuestEvent, type QuestHours, type QuestKind, type QuestRepeat, type QuestStep, type QuestView } from "./quest-model.ts";

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
const date = (value: unknown, name = "due") => {
	if (value === undefined || value === null || value === "") return undefined;
	if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value))) throw Error(`Give ${name} dates as YYYY-MM-DD.`);
	return value;
};
const weekdays = (value: unknown) => {
	if (!Array.isArray(value) || !value.length || value.some(day => !Number.isInteger(day) || day < 0 || day > 6)) throw Error("repeat.weekdays is a list of weekdays, 0 (Sunday) to 6 (Saturday).");
	return [...new Set(value as number[])].sort();
};
/** A schedule from a tool or the editor; a bare list of weekdays means weekly on those days, starting today. */
const repeat = (value: unknown, today: string): QuestRepeat | undefined => {
	if (value === undefined || value === null) return undefined;
	if (Array.isArray(value)) return value.length ? { every: 1, unit: "week", from: today, weekdays: weekdays(value) } : undefined;
	if (typeof value !== "object") throw Error("repeat is { every, unit, from, weekdays? }.");
	const { every = 1, unit = "day", from, weekdays: days } = value as Record<string, unknown>;
	if (!Number.isInteger(every) || (every as number) < 1 || (every as number) > 366) throw Error("repeat.every is a whole number from 1 to 366.");
	if (unit !== "day" && unit !== "week" && unit !== "month") throw Error('repeat.unit is "day", "week" or "month".');
	if (days !== undefined && unit !== "week") throw Error("repeat.weekdays only applies when unit is \"week\".");
	if (from !== undefined && (typeof from !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(from) || Number.isNaN(Date.parse(from)))) throw Error("repeat.from is a start date, YYYY-MM-DD.");
	return { every: every as number, unit, from: (from as string | undefined) ?? today, ...(days !== undefined ? { weekdays: weekdays(days) } : {}) };
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
			CREATE TABLE IF NOT EXISTS quest_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS quest_notices (id INTEGER PRIMARY KEY AUTOINCREMENT, computer TEXT NOT NULL, agent TEXT NOT NULL, text TEXT NOT NULL, created INTEGER NOT NULL);`);
		const columns = new Set((this.db.prepare("PRAGMA table_info(quests)").all() as { name: string }[]).map(row => row.name));
		if (!columns.has("repeat")) this.db.exec("ALTER TABLE quests ADD COLUMN repeat TEXT");
		if (!columns.has("scheduled")) this.db.exec("ALTER TABLE quests ADD COLUMN scheduled TEXT");
		if (!columns.has("turned_in")) {
			this.db.exec("ALTER TABLE quests ADD COLUMN turned_in INTEGER");
			// Finished quests used to leave the log after a day; keep those gone and today's waiting to be turned in.
			this.db.prepare("UPDATE quests SET turned_in=completed WHERE state='done' AND completed<?").run(Date.now() - 86_400_000);
		}
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
	/** A stored schedule; early repeating quests stored a bare list of weekdays, counted from the day they were added. */
	private schedule(value: unknown, created: number): QuestRepeat {
		return Array.isArray(value) ? { every: 1, unit: "week", from: localTime(created, this.hours().timeZone).date, weekdays: value as number[] } : value as QuestRepeat;
	}

	private row(value: Record<string, unknown> | undefined): Quest | undefined {
		if (!value) return;
		return { id: String(value.id), title: String(value.title), ...(value.notes ? { notes: String(value.notes) } : {}), kind: value.kind as QuestKind,
			state: value.state as Quest["state"], ...(value.due ? { due: String(value.due) } : {}), ...(value.scheduled ? { scheduled: String(value.scheduled) } : {}), ...(value.steps ? { steps: JSON.parse(String(value.steps)) } : {}),
			...(value.repeat ? { repeat: this.schedule(JSON.parse(String(value.repeat)), Number(value.created)) } : {}), ...(value.turned_in ? { turnedIn: Number(value.turned_in) } : {}),
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
		// Finished quests stay, marked ready, until Jordan or his Dot turns them in.
		const rows = this.db.prepare(`SELECT * FROM quests WHERE state='open' OR state='done' AND (turned_in IS NULL OR turned_in<completed)
			OR repeat IS NOT NULL AND state<>'abandoned' ORDER BY position, created`).all() as Record<string, unknown>[];
		const upcoming: Quest[] = [];
		const quests = rows.flatMap(row => {
			const quest = this.row(row)!;
			// A scheduled quest waits under Upcoming until its day.
			if (!quest.repeat) {
				if (quest.state === "open" && quest.scheduled && quest.scheduled > today) { upcoming.push({ ...quest, next: quest.scheduled }); return []; }
				return [quest];
			}
			// Open from each due date until done (late if past it), then waiting to be turned in, then resting until the next due date.
			const last = lastDue(quest.repeat, today), next = nextDue(quest.repeat, today);
			const done = !!last && !!quest.completed && localTime(quest.completed, hours.timeZone).date >= last;
			if (last && !done) return [{ ...quest, state: "open" as const, completed: undefined, turnedIn: undefined, ...(last < today ? { due: last } : {}), next }];
			if (done && isReady(quest)) return [{ ...quest, next }];
			upcoming.push({ ...quest, next });
			return [];
		});
		upcoming.sort((a, b) => a.next!.localeCompare(b.next!));
		const days = new Set<string>();
		for (const row of this.db.prepare("SELECT completed AS at FROM quests WHERE completed>? UNION SELECT at FROM quest_events WHERE action='completed' AND at>?")
			.all(at - 400 * 86_400_000, at - 400 * 86_400_000) as { at: number }[]) days.add(localTime(row.at, hours.timeZone).date);
		return { quests, upcoming, hours, today, onDuty: isOnDuty(hours, at), completedDays: [...days].sort().reverse(), revision: this.revision() };
	}

	/** Finished quests waiting to be turned in, oldest first. */
	ready(): Quest[] {
		return (this.db.prepare("SELECT * FROM quests WHERE state='done' AND (turned_in IS NULL OR turned_in<completed) ORDER BY completed").all() as Record<string, unknown>[])
			.map(row => this.row(row)!);
	}

	/** Quests in the log, oldest first, a batch at a time: for moving them to the computer that keeps Jordan's log. */
	batch(limit = 50): Quest[] {
		return (this.db.prepare("SELECT * FROM quests ORDER BY created,id LIMIT ?").all(limit) as Record<string, unknown>[]).map(row => this.row(row)!);
	}
	remove(ids: string[]): void {
		this.tx(() => { for (const id of ids) this.db.prepare("DELETE FROM quests WHERE id=?").run(id); });
		this.notify();
	}
	/**
	 * Quests another computer kept until now, added to this log with their history: open ones after its own, and an id
	 * already taken here replaced. source names the computer's agents as this log does. Returns the ids given.
	 */
	take(quests: unknown[], source: (actor: QuestActor) => QuestActor): string[] {
		const taken = this.tx(() => quests.map(value => {
			const quest = value as Quest, state = quest.state;
			if (typeof quest?.id !== "string" || !["open", "done", "abandoned"].includes(state) || !Number.isSafeInteger(quest.created)) throw Error("Invalid quest.");
			const id = this.get(quest.id) ? randomBytes(3).toString("hex") : quest.id;
			const last = (this.db.prepare("SELECT MAX(position) AS p FROM quests WHERE state='open'").get() as { p: number | null }).p;
			this.db.prepare(`INSERT INTO quests (id,title,notes,kind,state,due,steps,source,notify,position,created,updated,completed,repeat,scheduled,turned_in)
				VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, text(quest.title, 200, "title"), optionalText(quest.notes, 4000) ?? null, kind(quest.kind) ?? "side", state,
				date(quest.due) ?? null, quest.steps?.length ? JSON.stringify(steps(quest.steps)) : null, JSON.stringify(source(quest.source)), quest.notify ? 1 : 0,
				(last ?? 0) + 1, quest.created, Number(quest.updated) || quest.created, quest.completed ?? null, quest.repeat ? JSON.stringify(quest.repeat) : null,
				date(quest.scheduled, "scheduled") ?? null, quest.turnedIn ?? null);
			return quest.id;
		}));
		this.notify();
		return taken;
	}

	/** A message for an agent on another computer about a quest it added, kept until that computer takes it. */
	queueNotice(computer: string, agent: string, text: string): void {
		this.db.prepare("INSERT INTO quest_notices (computer,agent,text,created) VALUES (?,?,?,?)").run(computer, agent, text, Date.now());
		this.notify();
	}
	notices(computer: string): { id: number; agent: string; text: string }[] {
		this.db.prepare("DELETE FROM quest_notices WHERE created<?").run(Date.now() - 30 * 86_400_000);
		return this.db.prepare("SELECT id,agent,text FROM quest_notices WHERE computer=? ORDER BY id LIMIT 16").all(computer) as { id: number; agent: string; text: string }[];
	}
	dropNotices(computer: string, ids: number[]): void {
		for (const id of ids) this.db.prepare("DELETE FROM quest_notices WHERE computer=? AND id=?").run(computer, id);
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
			const now = Date.now(), today = localTime(now, this.hours().timeZone).date;
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
					const schedule = repeat(command.repeat, today);
					const on = schedule ? undefined : date(command.scheduled, "scheduled");
					const quest: Quest = { id: randomBytes(3).toString("hex"), title: text(command.title, 200, "title"), kind: schedule ? "daily" : kind(command.kind) ?? "side", state: "open",
						notes: optionalText(command.notes, 4000), due: schedule || on ? undefined : date(command.due), ...(on ? { scheduled: on } : {}), steps: steps(command.steps), ...(schedule ? { repeat: schedule } : {}), source: by,
						...(by.kind === "agent" && options.notify !== false ? { notify: true } : {}), created: now, updated: now };
					// Jordan's own quests go to the top; others' at the bottom.
					const position = by.kind === "you" ? (first ?? 0) - 1 : (last ?? 0) + 1;
					this.db.prepare(`INSERT INTO quests (id,title,notes,kind,state,due,steps,source,notify,position,created,updated,completed,repeat,scheduled)
						VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(quest.id, quest.title, quest.notes ?? null, quest.kind, "open",
						quest.due ?? null, quest.steps ? JSON.stringify(quest.steps) : null, JSON.stringify(quest.source), quest.notify ? 1 : 0, position, now, now, null,
						quest.repeat ? JSON.stringify(quest.repeat) : null, quest.scheduled ?? null);
					this.event(by, "added", quest); return quest;
				}
				case "update": {
					const quest = own(this.require(command.id));
					const next: Quest = { ...quest, updated: now,
						...(command.title !== undefined ? { title: text(command.title, 200, "title") } : {}),
						...(command.kind !== undefined ? { kind: kind(command.kind)! } : {}),
						...(command.notes !== undefined ? { notes: optionalText(command.notes, 4000) } : {}),
						...(command.due !== undefined ? { due: date(command.due) } : {}),
						...(command.scheduled !== undefined ? { scheduled: date(command.scheduled, "scheduled") } : {}),
						...(command.steps !== undefined ? { steps: steps(command.steps) } : {}),
						...(command.repeat !== undefined ? { repeat: repeat(command.repeat, today) } : {}) };
					// A quest has one kind of date: a repeat schedule, a scheduled day or a deadline. The one just given wins.
					if (next.repeat) { next.kind = "daily"; next.due = undefined; next.scheduled = undefined; }
					else if (next.scheduled && command.due === undefined) next.due = undefined;
					else if (next.due) next.scheduled = undefined;
					this.db.prepare("UPDATE quests SET title=?,notes=?,kind=?,due=?,scheduled=?,steps=?,repeat=?,updated=? WHERE id=?").run(next.title, next.notes ?? null, next.kind,
						next.due ?? null, next.scheduled ?? null, next.steps?.length ? JSON.stringify(next.steps) : null, next.repeat ? JSON.stringify(next.repeat) : null, now, quest.id);
					this.event(by, "updated", next); return next;
				}
				case "complete": case "abandon": case "reopen": {
					const quest = own(this.require(command.id));
					const state = command.action === "complete" ? "done" : command.action === "abandon" ? "abandoned" : "open";
					// A repeating quest is done again for each due date.
					const last = quest.repeat && lastDue(quest.repeat, today), timeZone = this.hours().timeZone;
					const doneForLast = !!last && !!quest.completed && localTime(quest.completed, timeZone).date >= last;
					if (quest.state === state && !(quest.repeat && state === "done" && !doneForLast)) return quest;
					this.db.prepare("UPDATE quests SET state=?,completed=?,updated=? WHERE id=?").run(state, state === "done" ? now : null, now, quest.id);
					const next = { ...quest, state, ...(state === "done" ? { completed: now } : { completed: undefined }), updated: now } as Quest;
					this.event(by, command.action === "complete" ? "completed" : command.action === "abandon" ? "abandoned" : "reopened", next); return next;
				}
				case "turnin": {
					const ready = command.id ? [own(this.require(command.id))].filter(isReady) : this.ready().filter(quest => by.kind !== "agent" || quest.source.kind === "agent" && quest.source.id === by.id);
					const update = this.db.prepare("UPDATE quests SET turned_in=?,updated=? WHERE id=?");
					for (const quest of ready) { update.run(now, now, quest.id); this.event(by, "turned_in", quest); }
					return ready[0] && { ...ready[0], turnedIn: now };
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
