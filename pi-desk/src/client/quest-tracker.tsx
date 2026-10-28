import { useEffect, useRef, useState, type DragEvent, type FormEvent, type KeyboardEvent } from "react";
import { api } from "./connection.ts";
import { Icon } from "./icons.tsx";
import { ActionMenu } from "./action-menu.tsx";
import type { UiAction } from "../../../pi-ui/index.ts";
import { isReady, isToday, lastDue, nextDue, repeatLabel, type QuestRepeat, QUEST_KIND_NAMES, QUEST_KINDS, type Quest, type QuestCommand, type QuestKind, type QuestView } from "../shared/quests.ts";

/** One computer's quest log as the browser sees it. */
export interface QuestLog { computer?: string; name: string; view: QuestView; connected: boolean }
/** resting: a repeating quest that is not due again yet. */
interface Item { quest: Quest; log: QuestLog; key: string; resting?: boolean }

const DAYS = ["S", "M", "T", "W", "T", "F", "S"];
const ASKS = [
	{ id: "steps", label: "Break into steps", prompt: "Break it into a few concrete steps and save them on the task." },
	{ id: "start", label: "Help me start", prompt: "Help me get started: what is the first small thing I should do?" },
	{ id: "blocked", label: "What's blocking it?", prompt: "Ask me what is blocking it, then suggest a way past that." },
	{ id: "draft", label: "Draft what I need", prompt: "Draft whatever I need to write or send for it." },
];

const shortDate = (date: string) => new Date(`${date}T12:00:00`).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
function dueLabel(due: string | undefined, today: string, repeating = false): { text: string; tone: string } | undefined {
	if (!due) return;
	if (repeating && due < today) return { text: `Late since ${shortDate(due)}`, tone: "overdue" };
	if (due < today) return { text: "Overdue", tone: "overdue" };
	if (due === today) return { text: "Due today", tone: "today" };
	return { text: `Due ${new Date(`${due}T12:00:00`).toLocaleDateString([], { day: "numeric", month: "short" })}`, tone: "" };
}
/** A scheduled day: shown on the day itself, or after it if not ticked off; before it the quest is under Upcoming. */
function scheduledLabel(on: string | undefined, today: string, resting?: boolean): { text: string; tone: string } | undefined {
	if (!on) return;
	if (resting || on > today) return { text: shortDate(on), tone: "" };
	return on === today ? { text: "Today", tone: "today" } : { text: `Was ${shortDate(on)}`, tone: "overdue" };
}

export function QuestTracker({ logs, primary, agentName, openAgent, ask }: {
	logs: QuestLog[];
	/** The computer whose log receives new tasks and whose working hours are edited. */
	primary?: string;
	agentName: (id: string) => string | undefined;
	openAgent: (id: string) => void;
	ask?: { name: string; send: (text: string) => void };
}) {
	const home = logs.find(log => log.computer === primary) ?? logs[0];
	const [error, setError] = useState(""), [title, setTitle] = useState(""), [notice, setNotice] = useState("");
	// Tasks are edited where they are; these say which task shows its add-subtask field, an empty notes field, or the schedule form.
	const [adding, setAdding] = useState<string>(), [noting, setNoting] = useState<string>(), [editing, setEditing] = useState<string>();
	const [focused, setFocused] = useState<string>(), [hoursOpen, setHoursOpen] = useState(false);
	const [collapsed, setCollapsed] = useState<string[]>(() => {
		try { const saved = JSON.parse(localStorage.getItem("pi-desk:tasks-collapsed") ?? "[]"); return Array.isArray(saved) ? saved.filter(id => typeof id === "string") : []; }
		catch { return []; }
	});
	// Changes are sent one at a time, in order, so a quick second change (a tick after editing notes) is neither lost nor reordered.
	const sending = useRef<Promise<unknown>>(Promise.resolve());
	const dragged = useRef<string | undefined>(undefined);
	useEffect(() => { localStorage.setItem("pi-desk:tasks-collapsed", JSON.stringify(collapsed)); }, [collapsed]);
	if (!home) return <aside className="quest-tracker"><p className="muted">Connect a computer with task support to see your list.</p></aside>;

	const run = async (log: QuestLog, command: QuestCommand) => {
		if (!log.connected) return false;
		setError(""); setNotice("");
		const send = sending.current.then(() => api("/quests", { command }, log.computer));
		sending.current = send.catch(() => {});
		try { await send; return true; }
		catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); return false; }
	};
	const items: Item[] = logs.flatMap(log => log.view.quests.map(quest => ({ quest, log, key: `${log.computer ?? "local"}:${quest.id}` })));
	const active = items.filter(item => item.quest.state === "open");
	const completed = items.filter(item => isReady(item.quest));
	const upcoming: Item[] = logs.flatMap(log => (log.view.upcoming ?? []).map(quest => ({ quest, log, key: `${log.computer ?? "local"}:${quest.id}`, resting: true })));
	const sections = [
		{ id: "today", label: "Today", items: active.filter(item => isToday(item.quest, item.log.view.today)) },
		{ id: "todo", label: "To do", items: active.filter(item => !isToday(item.quest, item.log.view.today)) },
		{ id: "upcoming", label: "Upcoming", items: upcoming },
		{ id: "completed", label: "Completed", items: completed },
	];
	const add = (event: FormEvent) => {
		event.preventDefault();
		const text = title.trim();
		if (text) void run(home, { action: "add", title: text, kind: "main" }).then(ok => { if (ok) setTitle(""); });
	};
	const drop = (target: Item | undefined, event: DragEvent) => {
		event.preventDefault(); event.stopPropagation();
		const moving = active.find(item => item.key === dragged.current); dragged.current = undefined;
		if (!moving || moving === target || target && target.log !== moving.log) return;
		void run(moving.log, { action: "move", id: moving.quest.id, before: target?.quest.id });
	};
	const row = (item: Item) => {
		const { quest, log } = item, finished = !item.resting && quest.state === "done";
		// A resting repeat still holds the previous occurrence's steps until the next due day.
		const restingRepeat = !!item.resting && !!quest.repeat;
		const editable = !finished && !restingRepeat, disabled = !log.connected;
		const due = finished ? undefined : dueLabel(quest.due, log.view.today, !!quest.repeat) ?? scheduledLabel(quest.scheduled, log.view.today, item.resting);
		const update = (fields: Omit<Extract<QuestCommand, { action: "update" }>, "action" | "id">) => run(log, { action: "update", id: quest.id, ...fields });
		const actions: UiAction[] = finished ? [{ id: "archive", label: "Archive" }] : [
			...(editable ? [{ id: "add-step", label: "Add subtask" }, ...(quest.notes ? [] : [{ id: "edit-notes", label: "Add notes" }])] : []),
			{ id: "mode", label: "Schedule & priority" },
			...(ask && log === home ? ASKS.map(({ id, label }) => ({ id: `ask:${id}`, label: `Ask ${ask.name}: ${label}` })) : []),
			{ id: "abandon", label: "Remove task", destructive: true },
		];
		const act = (action: UiAction) => {
			if (action.id === "add-step") setAdding(item.key);
			else if (action.id === "edit-notes") setNoting(item.key);
			else if (action.id === "mode") setEditing(item.key);
			else if (action.id === "archive") void run(log, { action: "turnin", id: quest.id });
			else if (action.id === "abandon") void run(log, { action: "abandon", id: quest.id });
			else if (ask) {
				const choice = ASKS.find(entry => `ask:${entry.id}` === action.id)!;
				ask.send(`About my task “${quest.title}” (quest id ${quest.id}): ${choice.prompt}`);
				setNotice(`Asked ${ask.name}`);
			}
		};
		return <li key={item.key} className={`quest${finished ? " done" : ""}`}
			// A row being typed in is not dragged, so its text can be selected.
			draggable={!disabled && !finished && !item.resting && focused !== item.key && editing !== item.key}
			onFocus={event => { if (event.target instanceof HTMLTextAreaElement) setFocused(item.key); }} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setFocused(undefined); }}
			onDragStart={() => { dragged.current = item.key; }} onDragOver={event => event.preventDefault()} onDrop={event => drop(item, event)}>
			<input type="checkbox" className="quest-check" checked={finished} disabled={disabled || restingRepeat}
				aria-label={`${finished ? "Reopen" : "Complete"} ${quest.title}`} title={restingRepeat ? "Available on the next due day" : undefined}
				onChange={() => void run(log, { action: finished ? "reopen" : "complete", id: quest.id })} />
			<div className="quest-body">
				<div className="quest-title-row">
					{editable ? <QuestField className="quest-title" label="Task title" value={quest.title} disabled={disabled}
						save={value => { if (value) void update({ title: value }); }} /> : <span className="quest-title">{quest.title}</span>}
					{!disabled && <ActionMenu label="Task actions" actions={actions} invoke={act} />}
				</div>
				<div className="quest-meta">
					{quest.repeat && <span>{repeatLabel(quest.repeat)}{item.resting && quest.next ? ` · next ${shortDate(quest.next)}` : ""}</span>}
					{due && <span className={`quest-due ${due.tone}`}>{due.text}</span>}
					{quest.source.kind === "agent" && quest.source.id && <button type="button" className="quest-source" title="Open the conversation that added this"
						onClick={() => openAgent(quest.source.id!)}>{agentName(quest.source.id) ?? quest.source.label ?? "Agent"}</button>}
					{logs.length > 1 && <span>{log.name}</span>}
					{!log.connected && <span>Offline · last known</span>}
				</div>
				{(quest.notes || noting === item.key) && (editable
					? <QuestField className="quest-notes" label="Notes" placeholder="Notes" multiline value={quest.notes ?? ""} disabled={disabled}
						autoFocus={noting === item.key} done={() => setNoting(undefined)} save={value => void update({ notes: value })} />
					: <p className="quest-notes">{quest.notes}</p>)}
				{(!!quest.steps?.length || adding === item.key) && <QuestSteps steps={quest.steps ?? []} editable={editable} disabled={disabled}
					adding={adding === item.key} stopAdding={() => setAdding(undefined)} save={steps => update({ steps })} />}
				{editing === item.key && <fieldset className="quest-settings" disabled={disabled}><QuestEditor quest={quest} today={log.view.today} cancel={() => setEditing(undefined)}
					save={fields => void update(fields).then(ok => { if (ok) setEditing(undefined); })} /></fieldset>}
			</div>
		</li>;
	};
	return <aside className="quest-tracker" aria-label="Tasks">
		<header className="quest-header">
			<span className="muted">{active.length + upcoming.length} open · {completed.length} completed</span>
			<button type="button" className="icon-button" aria-label="Working hours" aria-expanded={hoursOpen} onClick={() => setHoursOpen(value => !value)}><Icon name="clock" /></button>
		</header>
		{hoursOpen && <fieldset className="quest-settings" disabled={!home.connected}><QuestHoursEditor log={home} ask={ask} save={hours => void run(home, { action: "hours", hours })} /></fieldset>}
		<form className="quest-add" onSubmit={add}>
			<input value={title} onChange={event => setTitle(event.target.value)} placeholder="Add a task…" aria-label="New task" maxLength={200} disabled={!home.connected} />
			<button type="submit" disabled={!title.trim() || !home.connected}>Add</button>
		</form>
		{error && <p className="error-text" role="alert">{error}</p>}
		{notice && <p className="muted" role="status">{notice}</p>}
		<div className="quest-sections">
			{sections.map(section => section.items.length > 0 && <section key={section.id} className={`quest-section quest-${section.id}`}>
				<button type="button" className="quest-section-heading" aria-expanded={!collapsed.includes(section.id)}
					onClick={() => setCollapsed(current => current.includes(section.id) ? current.filter(id => id !== section.id) : [...current, section.id])}>
					<span className={`party-chevron${collapsed.includes(section.id) ? "" : " expanded"}`} aria-hidden="true">›</span>{section.label}<small>{section.items.length}</small></button>
				{!collapsed.includes(section.id) && <ol className="quest-list">{section.items.map(row)}</ol>}
			</section>)}
			{!active.length && !upcoming.length && <div className="quest-empty">
				<p>{completed.length ? "All tasks completed." : "No tasks yet."}</p>
				<p className="muted">Add a task above or ask {ask?.name ?? "your Dot"} to add something for you.</p>
			</div>}
		</div>
	</aside>;
}

/**
 * Text that is edited where it is shown: it looks like the text around it until it is focused. It saves when it loses
 * focus or on Enter (Ctrl+Enter in notes), and puts its value back on Escape. done is called whenever it loses focus.
 */
function QuestField({ value, save, done, label, placeholder, className, disabled, multiline, autoFocus }: {
	value: string; save: (value: string) => void; done?: () => void; label: string; placeholder?: string; className?: string; disabled?: boolean; multiline?: boolean; autoFocus?: boolean;
}) {
	const [text, setText] = useState(value), reverting = useRef(false);
	useEffect(() => setText(value), [value]);
	return <textarea rows={1} value={text} className={`quest-field ${className ?? ""}`} placeholder={placeholder} disabled={disabled} autoFocus={autoFocus}
		aria-label={label} maxLength={multiline ? 4000 : 300} spellCheck={multiline}
		onChange={event => setText(multiline ? event.target.value : event.target.value.replace(/\n/g, " "))}
		onBlur={() => { if (reverting.current) reverting.current = false; else if (text.trim() !== value.trim()) save(text.trim()); done?.(); }}
		onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
			if (event.key === "Escape") { reverting.current = true; setText(value); event.currentTarget.blur(); }
			else if (event.key === "Enter" && (!multiline || event.ctrlKey || event.metaKey)) { event.preventDefault(); event.currentTarget.blur(); }
		}} />;
}

/** A task's checklist, ticked and edited in place; clearing a subtask's text or its × removes it. */
function QuestSteps({ steps, save, disabled, editable, adding, stopAdding }: {
	steps: NonNullable<Quest["steps"]>; save: (steps: NonNullable<Quest["steps"]>) => Promise<boolean>; disabled?: boolean; editable: boolean;
	adding: boolean; stopAdding: () => void;
}) {
	// Kept here too, so changes made in quick succession build on each other before the list reports them back.
	const [items, setItems] = useState(steps), [draft, setDraft] = useState(""), discarding = useRef(false);
	const signature = JSON.stringify(steps);
	useEffect(() => setItems(steps), [signature]);
	const change = async (next: NonNullable<Quest["steps"]>) => {
		setItems(next);
		if (!await save(next)) setItems(steps);
	};
	return <ul className="quest-steps">
		{items.map((step, index) => <li key={`${index}:${step.title}`} className={step.done ? "done" : ""}>
			<input type="checkbox" checked={step.done} disabled={disabled || !editable} aria-label={`Done: ${step.title}`}
				onChange={() => void change(items.map((other, at) => at === index ? { ...other, done: !other.done } : other))} />
			{editable ? <>
				<QuestField className="quest-step" label="Subtask" value={step.title} disabled={disabled}
					save={title => void change(title ? items.map((other, at) => at === index ? { ...other, title } : other) : items.filter((_, at) => at !== index))} />
				<button type="button" className="quest-step-remove" aria-label={`Remove ${step.title}`} title="Remove subtask" disabled={disabled}
					onClick={() => void change(items.filter((_, at) => at !== index))}><Icon name="close" /></button>
			</> : <span className="quest-step">{step.title}</span>}
		</li>)}
		{adding && items.length < 30 && <li className="quest-step-new"><input type="checkbox" disabled aria-hidden="true" tabIndex={-1} />
			<textarea rows={1} className="quest-field quest-step" autoFocus value={draft} placeholder="Subtask" aria-label="Add a subtask" maxLength={300} disabled={disabled}
				onChange={event => setDraft(event.target.value.replace(/\n/g, " "))}
				// Leaving the field keeps what was typed, like every other field here; Escape discards it.
				onBlur={() => { if (draft.trim() && !discarding.current) void change([...items, { title: draft.trim(), done: false }]); discarding.current = false; setDraft(""); stopAdding(); }}
				onKeyDown={event => {
					if (event.key === "Escape") { event.preventDefault(); discarding.current = true; event.currentTarget.blur(); return; }
					if (event.key !== "Enter") return;
					event.preventDefault();
					const title = draft.trim();
					// Enter adds it and leaves the field open for the next one.
					if (title) { setDraft(""); void change([...items, { title, done: false }]); } else event.currentTarget.blur();
				}} /></li>}
	</ul>;
}

/** Schedule and priority use the shared task model, including calendar-based recurrence. */
function QuestEditor({ quest, today, save, cancel }: { quest: Quest; today: string; save: (fields: { kind: QuestKind; due: string; scheduled: string; repeat: QuestRepeat | null }) => void; cancel: () => void }) {
	const [kind, setKind] = useState(quest.kind);
	// One date: a deadline (due by) or the day it happens (scheduled on).
	const [dateKind, setDateKind] = useState<"due" | "scheduled">(quest.scheduled ? "scheduled" : "due"), [due, setDue] = useState(quest.repeat ? "" : quest.scheduled ?? quest.due ?? "");
	const [unit, setUnit] = useState<QuestRepeat["unit"] | "">(quest.repeat?.unit ?? ""), [every, setEvery] = useState(quest.repeat?.every ?? 1);
	const [from, setFrom] = useState(quest.repeat?.from ?? today), [days, setDays] = useState<number[]>(quest.repeat?.weekdays ?? []);
	const schedule: QuestRepeat | null = unit && /^\d{4}-\d{2}-\d{2}$/.test(from) ? { every: Math.max(1, Math.min(366, Math.round(every) || 1)), unit, from, ...(unit === "week" && days.length ? { weekdays: days } : {}) } : null;
	const firstDue = schedule && (lastDue(schedule, today) === today ? today : nextDue(schedule, today));
	return <form className="quest-editor" onSubmit={event => {
		event.preventDefault();
		save({ kind: schedule ? "daily" : kind, due: schedule || dateKind !== "due" ? "" : due, scheduled: schedule || dateKind !== "scheduled" ? "" : due, repeat: schedule });
	}}>
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
				<select value={kind} onChange={event => setKind(event.target.value as QuestKind)} aria-label="Priority">{QUEST_KINDS.map(value => <option key={value} value={value}>{QUEST_KIND_NAMES[value]}</option>)}</select>
				<select value={dateKind} onChange={event => setDateKind(event.target.value as "due" | "scheduled")} aria-label="Date means"
					title="Due by: a deadline you can act on before. Happens on: an appointment or event, kept under Upcoming until the day.">
					<option value="due">Due by</option><option value="scheduled">Happens on</option></select>
				<input type="date" value={due} onChange={event => setDue(event.target.value)} aria-label={dateKind === "due" ? "Due date" : "Scheduled date"} />
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
			ask.send("Please set up a recurring task: every hour on my working days, check my task list with quest_log and follow its guidance. Outside working hours it tells you to do nothing; when nothing has changed, stay quiet. Only message me when something needs my attention, such as a task an agent added for me or something due today.");
			setAsked(true);
		}}>{asked ? `Asked ${ask.name}` : `Ask ${ask.name} to check in hourly`}</button>}
	</div>;
}
