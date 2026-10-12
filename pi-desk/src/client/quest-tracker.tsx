import { useEffect, useRef, useState, type DragEvent, type FormEvent } from "react";
import { api } from "./connection.ts";
import { Icon } from "./icons.tsx";
import { ActionMenu } from "./action-menu.tsx";
import { isReady, isToday, lastDue, localTime, nextDue, questStreak, repeatLabel, type QuestRepeat, QUEST_KIND_NAMES, QUEST_KINDS, type Quest, type QuestCommand, type QuestKind, type QuestView } from "../shared/quests.ts";

/** Classic quest-giver markers: ! until the quest is done, then ? until it is turned in. Dailies and repeatables are blue. */
function QuestMarker({ quest, finishing, resting }: { quest: Quest; finishing: boolean; resting?: boolean }) {
	const ready = !resting && (quest.state === "done" || finishing || !!quest.steps?.length && quest.steps.every(step => step.done));
	const glyph = ready ? "?" : "!", tone = quest.kind === "daily" || quest.repeat ? "blue" : "gold";
	return <svg className={`quest-marker marker-${tone}`} viewBox="0 0 20 24" aria-hidden="true">
		<text x="10" y="20" textAnchor="middle">{glyph}</text>
	</svg>;
}

/** One computer's quest log as the browser sees it. */
export interface QuestLog { computer?: string; name: string; view: QuestView; connected: boolean }
/** resting: a repeating quest that is not due again yet. */
interface Item { quest: Quest; log: QuestLog; key: string; resting?: boolean }

const DAYS = ["S", "M", "T", "W", "T", "F", "S"];
const ASKS = [
	{ id: "steps", label: "Break into steps", prompt: "Break it into a few concrete steps and save them on the quest." },
	{ id: "start", label: "Help me start", prompt: "Help me get started: what is the first small thing I should do?" },
	{ id: "blocked", label: "What's blocking it?", prompt: "Ask me what is blocking it, then suggest a way past that." },
	{ id: "draft", label: "Draft what I need", prompt: "Draft whatever I need to write or send for it." },
];

let audio: AudioContext | undefined;
/** A short rising chime, like turning in a quest. */
function chime(): void {
	try {
		audio ??= new AudioContext();
		const start = audio.currentTime;
		[659.25, 880, 1318.5].forEach((frequency, index) => {
			const oscillator = audio!.createOscillator(), gain = audio!.createGain(), at = start + index * 0.09;
			oscillator.type = "triangle"; oscillator.frequency.value = frequency;
			gain.gain.setValueAtTime(0.0001, at); gain.gain.exponentialRampToValueAtTime(0.12, at + 0.02); gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.45);
			oscillator.connect(gain).connect(audio!.destination); oscillator.start(at); oscillator.stop(at + 0.5);
		});
	} catch { /* Sound is a flourish only. */ }
}

const shortDate = (date: string) => new Date(`${date}T12:00:00`).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
function dueLabel(due: string | undefined, today: string, repeating = false): { text: string; tone: string } | undefined {
	if (!due) return;
	if (repeating) return { text: `Late since ${shortDate(due)}`, tone: "overdue" };
	if (due < today) return { text: "Overdue", tone: "overdue" };
	if (due === today) return { text: "Due today", tone: "today" };
	return { text: `Due ${new Date(`${due}T12:00:00`).toLocaleDateString([], { day: "numeric", month: "short" })}`, tone: "" };
}

export function QuestTracker({ logs, primary, agentName, openAgent, ask }: {
	logs: QuestLog[];
	/** The computer whose log new quests go to and whose working hours are edited: the Dot's. */
	primary?: string;
	/** A conversation's title for an agent id, and opening it. */
	agentName: (id: string) => string | undefined;
	openAgent: (id: string) => void;
	/** Send the Dot a message, when it is connected. */
	ask?: { name: string; send: (text: string) => void };
}) {
	const home = logs.find(log => log.computer === primary) ?? logs[0];
	const [error, setError] = useState(""), [title, setTitle] = useState("");
	const [open, setOpen] = useState<string>(), [editing, setEditing] = useState<string>(), [hoursOpen, setHoursOpen] = useState(false);
	const [collapsed, setCollapsed] = useState<string[]>(() => { try { return JSON.parse(localStorage.getItem("pi-desk:quest-collapsed") ?? '["upcoming"]'); } catch { return ["upcoming"]; } });
	const [sound, setSound] = useState(() => localStorage.getItem("pi-desk:quest-sound") !== "off");
	const [finishing, setFinishing] = useState<string[]>([]), [toast, setToast] = useState<{ kind: "complete" | "asked"; text: string }>();
	const dragged = useRef<string | undefined>(undefined);
	useEffect(() => { localStorage.setItem("pi-desk:quest-collapsed", JSON.stringify(collapsed)); }, [collapsed]);
	useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(undefined), 2600); return () => clearTimeout(timer); }, [toast]);
	if (!home) return <aside className="quest-tracker"><p className="muted">The quest log needs Desk 0.5.62 on a connected computer.</p></aside>;

	const run = async (log: QuestLog, command: QuestCommand) => {
		setError("");
		try { await api("/quests", { command }, log.computer); return true; }
		catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); return false; }
	};
	const items: Item[] = [...logs].sort((a, b) => Number(b === home) - Number(a === home))
		.flatMap(log => log.view.quests.map(quest => ({ quest, log, key: `${log.computer ?? "local"}:${quest.id}` })));
	// Finished quests keep their place, marked "?", until turned in. Importance shows as title colour, like quest level.
	const today = home.view.today, live = items.filter(item => item.quest.state === "open" || isReady(item.quest));
	const sections = [
		{ id: "today", label: "Daily", items: live.filter(item => isToday(item.quest, today)) },
		{ id: "log", label: "Quests", items: live.filter(item => !isToday(item.quest, today)) },
	];
	const resting: Item[] = logs.flatMap(log => (log.view.upcoming ?? []).map(quest => ({ quest, log, key: `${log.computer ?? "local"}:${quest.id}`, resting: true })));
	sections.push({ id: "upcoming", label: "Repeating", items: resting });
	const ready = live.filter(item => isReady(item.quest));
	const done = ready.filter(item => localTime(item.quest.completed!, home.view.hours.timeZone).date === today).length;
	const total = done + sections[0]!.items.filter(item => item.quest.state === "open").length;
	const streak = questStreak(logs.flatMap(log => log.view.completedDays), home.view.hours);

	const complete = (item: Item) => {
		if (finishing.includes(item.key)) return;
		setFinishing(current => [...current, item.key]);
		if (sound) chime();
		setToast({ kind: "complete", text: item.quest.title });
		// Let the flourish play before the marker turns to "?".
		setTimeout(() => void run(item.log, { action: "complete", id: item.quest.id }).finally(() => setFinishing(current => current.filter(key => key !== item.key))), 650);
	};
	const add = (event: FormEvent) => {
		event.preventDefault();
		const text = title.trim();
		if (!text) return;
		// A typed quest is a normal (yellow) quest; Edit changes its kind.
		void run(home, { action: "add", title: text, kind: "main" }).then(ok => { if (ok) setTitle(""); });
	};
	const drop = (target: Item | undefined, event: DragEvent) => {
		event.preventDefault();
		const moving = items.find(item => item.key === dragged.current); dragged.current = undefined;
		if (!moving || moving === target || target && target.log !== moving.log) return;
		void run(moving.log, { action: "move", id: moving.quest.id, before: target?.quest.id });
	};
	const source = (item: Item) => {
		const from = item.quest.source;
		if (from.kind === "agent" && from.id) return <button type="button" className="quest-source" title="Open the conversation that added this"
			onClick={() => openAgent(from.id!)}>{agentName(from.id) ?? from.label ?? "Agent"}</button>;
		return null;
	};

	const row = (item: Item) => {
		const { quest } = item, expanded = open === item.key, due = dueLabel(quest.due, today, !!quest.repeat), finished = !item.resting && quest.state === "done";
		return <li key={item.key} className={`quest quest-${quest.kind}${finished ? " done" : ""}${item.resting ? " resting" : ""}${finishing.includes(item.key) ? " finishing" : ""}${expanded ? " expanded" : ""}`}
			draggable={!finished && !item.resting && !editing} onDragStart={() => { dragged.current = item.key; }} onDragOver={event => event.preventDefault()} onDrop={event => drop(item, event)}>
			<button type="button" className="quest-check" aria-label={finished ? `Reopen ${quest.title}` : `Complete ${quest.title}`} title={finished ? "Ready to turn in. Click to reopen" : "Complete"}
				disabled={!item.log.connected || item.resting} onClick={() => finished ? void run(item.log, { action: "reopen", id: quest.id }) : complete(item)}>
				<QuestMarker quest={quest} finishing={finishing.includes(item.key)} resting={item.resting} /></button>
			<div className="quest-body">
				{editing === item.key ? <QuestEditor quest={quest} today={item.log.view.today} cancel={() => setEditing(undefined)}
					save={fields => void run(item.log, { action: "update", id: quest.id, ...fields }).then(ok => { if (ok) setEditing(undefined); })} /> : <>
					<button type="button" className="quest-title" aria-expanded={expanded} onClick={() => setOpen(expanded ? undefined : item.key)}>{quest.title}</button>
					{quest.steps && !expanded && <ul className="quest-objectives">{quest.steps.slice(0, 6).map((step, index) =>
						<li key={index} className={step.done ? "done" : ""}>- {step.title}{step.done && " (Complete)"}</li>)}
						{quest.steps.length > 6 && <li>- {quest.steps.length - 6} more</li>}</ul>}
					<div className="quest-meta">
						{quest.repeat && <span className="quest-repeat">{repeatLabel(quest.repeat)}{item.resting && quest.next ? ` · next ${shortDate(quest.next)}` : ""}</span>}
						{due && <span className={`quest-due ${due.tone}`}>{due.text}</span>}
						{source(item)}
						{item.log !== home && <span className="quest-computer">{item.log.name}</span>}
					</div>
					{expanded && <div className="quest-detail">
						{quest.notes && <p className="quest-notes">{quest.notes}</p>}
						{quest.steps && <ul className="quest-steps">{quest.steps.map((step, index) => <li key={index}>
							<label><input type="checkbox" checked={step.done} disabled={finished || !item.log.connected} onChange={() => void run(item.log, { action: "update", id: quest.id,
								steps: quest.steps!.map((other, at) => at === index ? { ...other, done: !other.done } : other) })} />{step.title}</label></li>)}</ul>}
						{finished && <div className="quest-actions">
							<button type="button" className="quiet-action" disabled={!item.log.connected} onClick={() => void run(item.log, { action: "turnin", id: quest.id })}><Icon name="check" />Turn in</button>
							<button type="button" className="quiet-action" disabled={!item.log.connected} onClick={() => void run(item.log, { action: "reopen", id: quest.id })}>Reopen</button>
						</div>}
						{!finished && <div className="quest-actions">
							<button type="button" className="quiet-action" disabled={!item.log.connected} onClick={() => setEditing(item.key)}><Icon name="edit" />Edit</button>
							{ask && item.log === home && <ActionMenu label={`Ask ${ask.name}`} actions={ASKS.map(({ id, label }) => ({ id, label }))} invoke={action => {
								const choice = ASKS.find(entry => entry.id === action.id)!;
								ask.send(`About my quest “${quest.title}” (quest id ${quest.id}): ${choice.prompt}`);
								setToast({ kind: "asked", text: `Asked ${ask.name}` });
							}} />}
							<button type="button" className="quiet-action" disabled={!item.log.connected} onClick={() => void run(item.log, { action: "abandon", id: quest.id })}>Abandon</button>
						</div>}
					</div>}
				</>}
			</div>
		</li>;
	};

	return <aside className="quest-tracker" aria-label="Quests">
		<header className="quest-header">
			<div><strong>Quests</strong>
				{total > 0 && <span className="quest-progress" title={`${done} of ${total} done today`}><span style={{ width: `${Math.round(done / total * 100)}%` }} /></span>}
				<small>{total ? `${done}/${total} today` : done ? `${done} done today` : ""}{streak > 1 ? ` · ${streak}-day streak` : ""}</small></div>
			<div className="quest-header-actions">
				{ready.length > 0 && <button type="button" className="quiet-action quest-turnin" title={`Turn in ${ready.length} finished ${ready.length === 1 ? "quest" : "quests"}${ask ? `. ${ask.name} does this when it next reads the log` : ""}`}
					onClick={() => { for (const log of logs) if (log.connected && ready.some(item => item.log === log)) void run(log, { action: "turnin" }); }}>Turn in {ready.length}</button>}
				<button type="button" className="icon-button" aria-pressed={sound} title={sound ? "Completion sound on" : "Completion sound off"}
					onClick={() => { const next = !sound; setSound(next); localStorage.setItem("pi-desk:quest-sound", next ? "on" : "off"); if (next) chime(); }}>
					<Icon name={sound ? "sound" : "sound-off"} /></button>
				<button type="button" className="icon-button" aria-expanded={hoursOpen} title="Working hours" onClick={() => setHoursOpen(value => !value)}><Icon name="clock" /></button>
			</div>
		</header>
		{toast && <div className={`quest-toast ${toast.kind}`} role="status"><span>{toast.kind === "asked" ? toast.text : <><strong className="quest-toast-heading">{toast.text} completed.</strong></>}</span></div>}
		{hoursOpen && <QuestHoursEditor log={home} ask={ask} save={hours => void run(home, { action: "hours", hours })} />}
		<form className="quest-add" onSubmit={add}>
			<input value={title} onChange={event => setTitle(event.target.value)} placeholder="Add a quest…" aria-label="New quest" maxLength={200} disabled={!home.connected} />
		</form>
		{error && <p className="error-text" role="alert">{error}</p>}
		<div className="quest-sections">
			{sections.map(section => section.items.length > 0 && <section key={section.id} className={`quest-section quest-${section.id}`}
				onDragOver={event => event.preventDefault()} onDrop={event => drop(undefined, event)}>
				<button type="button" className="quest-section-heading" aria-expanded={!collapsed.includes(section.id)}
					onClick={() => setCollapsed(current => current.includes(section.id) ? current.filter(id => id !== section.id) : [...current, section.id])}>
					<span className={`party-chevron${collapsed.includes(section.id) ? "" : " expanded"}`} aria-hidden="true">›</span>{section.label}<small>{section.items.length}</small></button>
				{!collapsed.includes(section.id) && <ol className="quest-list">{section.items.map(row)}</ol>}
			</section>)}
			{!live.length && <div className="quest-empty">
				<p>{done ? "All clear. Nice work." : "No quests yet."}</p>
				<p className="muted">Add one above, tell {ask?.name ?? "your Dot"} to remember something, or let agents add things they need you to review.</p>
				{ask && !done && <button type="button" className="quiet-action" onClick={() => { ask.send("Please move everything on the to-do list you have been keeping for me into my quest log with quest_add, then stop keeping it separately."); setToast({ kind: "asked", text: `Asked ${ask.name}` }); }}>
					Ask {ask.name} to import my to-do list</button>}
			</div>}
		</div>
	</aside>;
}

function QuestEditor({ quest, today, save, cancel }: { quest: Quest; today: string; save: (fields: { title: string; notes: string; kind: QuestKind; due: string; steps?: Quest["steps"]; repeat: QuestRepeat | null }) => void; cancel: () => void }) {
	const [title, setTitle] = useState(quest.title), [notes, setNotes] = useState(quest.notes ?? ""), [kind, setKind] = useState(quest.kind), [due, setDue] = useState(quest.repeat ? "" : quest.due ?? "");
	const [unit, setUnit] = useState<QuestRepeat["unit"] | "">(quest.repeat?.unit ?? ""), [every, setEvery] = useState(quest.repeat?.every ?? 1);
	const [from, setFrom] = useState(quest.repeat?.from ?? today), [days, setDays] = useState<number[]>(quest.repeat?.weekdays ?? []);
	const schedule: QuestRepeat | null = unit && /^\d{4}-\d{2}-\d{2}$/.test(from) ? { every: Math.max(1, Math.min(366, Math.round(every) || 1)), unit, from, ...(unit === "week" && days.length ? { weekdays: days } : {}) } : null;
	const firstDue = schedule && (lastDue(schedule, today) === today ? today : nextDue(schedule, today));
	const [steps, setSteps] = useState((quest.steps ?? []).map(step => step.title).join("\n"));
	return <form className="quest-editor" onSubmit={event => {
		event.preventDefault();
		const lines = steps.split("\n").map(line => line.trim()).filter(Boolean);
		save({ title, notes, kind: schedule ? "daily" : kind, due: schedule ? "" : due, repeat: schedule, steps: lines.map(line => ({ title: line, done: quest.steps?.find(step => step.title === line)?.done ?? false })) });
	}}>
		<input value={title} onChange={event => setTitle(event.target.value)} aria-label="Quest title" maxLength={200} autoFocus />
		<textarea value={notes} onChange={event => setNotes(event.target.value)} placeholder="Notes" aria-label="Notes" rows={2} />
		<textarea value={steps} onChange={event => setSteps(event.target.value)} placeholder="Steps, one per line" aria-label="Steps" rows={2} />
		<div className="quest-editor-row quest-repeat-row">
			<select value={unit} onChange={event => setUnit(event.target.value as QuestRepeat["unit"] | "")} aria-label="Repeats">
				<option value="">Doesn't repeat</option><option value="day">Repeats by day</option><option value="week">Repeats by week</option><option value="month">Repeats by month</option></select>
			{unit && <><label>every <input type="number" min={1} max={366} value={every} onChange={event => setEvery(Number(event.target.value))} aria-label="Every" /></label>
				<label>from <input type="date" value={from} onChange={event => setFrom(event.target.value)} aria-label="Starting" /></label></>}
		</div>
		{unit === "week" && <div className="quest-days" role="group" aria-label="Due on">{DAYS.map((label, day) => <button type="button" key={day} aria-pressed={days.includes(day)}
			title={["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][day]}
			onClick={() => setDays(current => current.includes(day) ? current.filter(value => value !== day) : [...current, day].sort())}>{label}</button>)}</div>}
		{schedule ? <small className="muted">Repeats: {repeatLabel(schedule)}{firstDue ? `. ${firstDue === today ? "Due today" : `Next due ${shortDate(firstDue)}`}` : ""}. Doing it late doesn't move the schedule.</small>
			: <div className="quest-editor-row">
				<select value={kind} onChange={event => setKind(event.target.value as QuestKind)} aria-label="Kind">{QUEST_KINDS.map(value => <option key={value} value={value}>{QUEST_KIND_NAMES[value]}</option>)}</select>
				<input type="date" value={due} onChange={event => setDue(event.target.value)} aria-label="Due date" />
			</div>}
		<div className="quest-editor-row"><button type="button" onClick={cancel}>Cancel</button><button className="primary" type="submit">Save</button></div>
	</form>;
}

function QuestHoursEditor({ log, save, ask }: { log: QuestLog; save: (hours: { days?: number[]; start?: number; end?: number }) => void; ask?: { name: string; send: (text: string) => void } }) {
	const hours = log.view.hours, hour = (value: number) => `${String(value).padStart(2, "0")}:00`;
	const [asked, setAsked] = useState(false);
	return <div className="quest-hours">
		<p className="muted">{ask?.name ?? "Your Dot"}'s scheduled check-ins change the list only during these hours ({hours.timeZone}). Anything you ask for directly works any time.</p>
		<div className="quest-days" role="group" aria-label="Working days">{DAYS.map((label, day) => <button type="button" key={day} aria-pressed={hours.days.includes(day)}
			title={["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][day]}
			onClick={() => save({ days: hours.days.includes(day) ? hours.days.filter(value => value !== day) : [...hours.days, day] })}>{label}</button>)}</div>
		<div className="quest-editor-row">
			<select aria-label="Start" value={hours.start} onChange={event => save({ start: Number(event.target.value) })}>{Array.from({ length: 24 }, (_, value) => <option key={value} value={value}>{hour(value)}</option>)}</select>
			<span>to</span>
			<select aria-label="End" value={hours.end} onChange={event => save({ end: Number(event.target.value) })}>{Array.from({ length: 24 }, (_, value) => value + 1).map(value => <option key={value} value={value}>{hour(value)}</option>)}</select>
		</div>
		{ask && <button type="button" className="quiet-action" disabled={asked} onClick={() => {
			ask.send("Please set up a recurring task: every hour on my working days, check my quest log with quest_log and follow its guidance. Outside working hours it tells you to do nothing; when nothing has changed, stay quiet. Only message me when something needs my attention, such as a quest an agent added for me or something due today.");
			setAsked(true);
		}}>{asked ? `Asked ${ask.name}` : `Ask ${ask.name} to check in hourly`}</button>}
	</div>;
}
