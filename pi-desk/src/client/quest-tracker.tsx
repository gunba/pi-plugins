import { useEffect, useRef, useState, type DragEvent, type FormEvent } from "react";
import { api } from "./connection.ts";
import { Icon } from "./icons.tsx";
import { ActionMenu } from "./action-menu.tsx";
import { isToday, questStreak, QUEST_KIND_NAMES, QUEST_KINDS, type Quest, type QuestCommand, type QuestKind, type QuestView } from "../shared/quests.ts";

/** One computer's quest log as the browser sees it. */
export interface QuestLog { computer?: string; name: string; view: QuestView; connected: boolean }
interface Item { quest: Quest; log: QuestLog; key: string }

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

function dueLabel(due: string | undefined, today: string): { text: string; tone: string } | undefined {
	if (!due) return;
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
	const [error, setError] = useState(""), [title, setTitle] = useState(""), [kind, setKind] = useState<QuestKind>("side");
	const [open, setOpen] = useState<string>(), [editing, setEditing] = useState<string>(), [hoursOpen, setHoursOpen] = useState(false);
	const [collapsed, setCollapsed] = useState<string[]>(() => { try { return JSON.parse(localStorage.getItem("pi-desk:quest-collapsed") ?? '["done"]'); } catch { return ["done"]; } });
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
	const today = home.view.today, live = items.filter(item => item.quest.state === "open");
	const sections = [
		{ id: "today", label: "Today", items: live.filter(item => isToday(item.quest, today)) },
		{ id: "main", label: "Main quests", items: live.filter(item => !isToday(item.quest, today) && item.quest.kind === "main") },
		{ id: "side", label: "Side quests", items: live.filter(item => !isToday(item.quest, today) && item.quest.kind === "side") },
		{ id: "done", label: "Completed today", items: items.filter(item => item.quest.state === "done") },
	];
	const done = sections[3]!.items.length, total = done + sections[0]!.items.length;
	const streak = questStreak(logs.flatMap(log => log.view.completedDays), home.view.hours);

	const complete = (item: Item) => {
		if (finishing.includes(item.key)) return;
		setFinishing(current => [...current, item.key]);
		if (sound) chime();
		setToast({ kind: "complete", text: item.quest.title });
		// Let the flourish play before the quest moves to Completed.
		setTimeout(() => void run(item.log, { action: "complete", id: item.quest.id }).finally(() => setFinishing(current => current.filter(key => key !== item.key))), 650);
	};
	const add = (event: FormEvent) => {
		event.preventDefault();
		const text = title.trim();
		if (!text) return;
		void run(home, { action: "add", title: text, kind }).then(ok => { if (ok) setTitle(""); });
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
		if (from.kind === "dot") return <span className="quest-source">{ask?.name ?? "Dot"}</span>;
		return null;
	};

	const row = (item: Item) => {
		const { quest } = item, expanded = open === item.key, due = dueLabel(quest.due, today), finished = quest.state === "done";
		const stepsDone = quest.steps?.filter(step => step.done).length ?? 0;
		return <li key={item.key} className={`quest${finished ? " done" : ""}${finishing.includes(item.key) ? " finishing" : ""}${expanded ? " expanded" : ""}`}
			draggable={!finished && !editing} onDragStart={() => { dragged.current = item.key; }} onDragOver={event => event.preventDefault()} onDrop={event => drop(item, event)}>
			<button type="button" className="quest-check" aria-label={finished ? `Reopen ${quest.title}` : `Complete ${quest.title}`} disabled={!item.log.connected}
				onClick={() => finished ? void run(item.log, { action: "reopen", id: quest.id }) : complete(item)}>{(finished || finishing.includes(item.key)) && <Icon name="check" />}</button>
			<div className="quest-body">
				{editing === item.key ? <QuestEditor quest={quest} cancel={() => setEditing(undefined)}
					save={fields => void run(item.log, { action: "update", id: quest.id, ...fields }).then(ok => { if (ok) setEditing(undefined); })} /> : <>
					<button type="button" className="quest-title" aria-expanded={expanded} onClick={() => setOpen(expanded ? undefined : item.key)}>{quest.title}</button>
					<div className="quest-meta">
						{quest.steps && <span>{stepsDone}/{quest.steps.length}</span>}
						{due && <span className={`quest-due ${due.tone}`}>{due.text}</span>}
						{source(item)}
						{item.log !== home && <span className="quest-computer">{item.log.name}</span>}
					</div>
					{expanded && <div className="quest-detail">
						{quest.notes && <p className="quest-notes">{quest.notes}</p>}
						{quest.steps && <ul className="quest-steps">{quest.steps.map((step, index) => <li key={index}>
							<label><input type="checkbox" checked={step.done} disabled={finished || !item.log.connected} onChange={() => void run(item.log, { action: "update", id: quest.id,
								steps: quest.steps!.map((other, at) => at === index ? { ...other, done: !other.done } : other) })} />{step.title}</label></li>)}</ul>}
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
				<button type="button" className="icon-button" aria-pressed={sound} title={sound ? "Completion sound on" : "Completion sound off"}
					onClick={() => { const next = !sound; setSound(next); localStorage.setItem("pi-desk:quest-sound", next ? "on" : "off"); if (next) chime(); }}>
					<Icon name={sound ? "sound" : "sound-off"} /></button>
				<button type="button" className="icon-button" aria-expanded={hoursOpen} title="Working hours" onClick={() => setHoursOpen(value => !value)}><Icon name="clock" /></button>
			</div>
		</header>
		{toast && <div className={`quest-toast ${toast.kind}`} role="status"><Icon name="check" /><span>{toast.kind === "asked" ? toast.text : <>Quest complete<small>{toast.text}</small></>}</span></div>}
		{hoursOpen && <QuestHoursEditor log={home} ask={ask} save={hours => void run(home, { action: "hours", hours })} />}
		<form className="quest-add" onSubmit={add}>
			<input value={title} onChange={event => setTitle(event.target.value)} placeholder="Add a quest…" aria-label="New quest" maxLength={200} disabled={!home.connected} />
			<div className="quest-kinds" role="radiogroup" aria-label="Quest kind">{QUEST_KINDS.map(value => <button type="button" role="radio" aria-checked={kind === value} key={value}
				onClick={() => setKind(value)}>{QUEST_KIND_NAMES[value]}</button>)}</div>
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

function QuestEditor({ quest, save, cancel }: { quest: Quest; save: (fields: { title: string; notes: string; kind: QuestKind; due: string; steps?: Quest["steps"] }) => void; cancel: () => void }) {
	const [title, setTitle] = useState(quest.title), [notes, setNotes] = useState(quest.notes ?? ""), [kind, setKind] = useState(quest.kind), [due, setDue] = useState(quest.due ?? "");
	const [steps, setSteps] = useState((quest.steps ?? []).map(step => step.title).join("\n"));
	return <form className="quest-editor" onSubmit={event => {
		event.preventDefault();
		const lines = steps.split("\n").map(line => line.trim()).filter(Boolean);
		save({ title, notes, kind, due, steps: lines.map(line => ({ title: line, done: quest.steps?.find(step => step.title === line)?.done ?? false })) });
	}}>
		<input value={title} onChange={event => setTitle(event.target.value)} aria-label="Quest title" maxLength={200} autoFocus />
		<textarea value={notes} onChange={event => setNotes(event.target.value)} placeholder="Notes" aria-label="Notes" rows={2} />
		<textarea value={steps} onChange={event => setSteps(event.target.value)} placeholder="Steps, one per line" aria-label="Steps" rows={2} />
		<div className="quest-editor-row">
			<select value={kind} onChange={event => setKind(event.target.value as QuestKind)} aria-label="Kind">{QUEST_KINDS.map(value => <option key={value} value={value}>{QUEST_KIND_NAMES[value]}</option>)}</select>
			<input type="date" value={due} onChange={event => setDue(event.target.value)} aria-label="Due date" />
		</div>
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
