import { createContext, memo, useContext, useMemo, useState, type ComponentProps } from "react";
import Markdown, { type Components, type ExtraProps } from "react-markdown";
import { useConfirmation } from "./confirmation.tsx";
import type { HomeWatch, HomeWork } from "../shared/home.ts";
import { wakeLabel } from "./activity.ts";
import { markdownPlugins, markdownUrl } from "./markdown-links.ts";

/** A run of the page's lines: line is the file line (from 1) of the body's first line, end its last. */
interface Part { body: string; line: number; end: number }
/**
 * The page split at its ## headings: what comes before the first spans the page, and each section is a column. Hidden
 * parts keep their line breaks, so each shown line has its file line and a change on the page goes to the right line.
 */
function sections(page: string): { lead: Part; columns: (Part & { title: string; heading: number })[] } {
	// Notes the agent keeps for itself sit in HTML comments, which the page doesn't show.
	const lines = page.replace(/<!--[\s\S]*?-->/g, comment => "\n".repeat(comment.split("\n").length - 1)).split("\n");
	const columns: (Part & { title: string; heading: number })[] = [], lead: Part = { body: "", line: 1, end: 0 };
	let fence = false, titled = false;
	lines.forEach((text, index) => {
		const line = index + 1;
		if (/^\s*(```|~~~)/.test(text)) fence = !fence;
		const heading = !fence && /^##\s+(.*)$/.exec(text);
		if (heading) { columns.push({ title: heading[1]!.trim(), heading: line, body: "", line: line + 1, end: line }); return; }
		const part = columns.at(-1) ?? lead;
		// Home's header names the page, so a title line is left out.
		const shown = part === lead && !titled && /^#\s+/.test(text) ? (titled = true, "") : text;
		part.body += (part.body || part.end >= part.line ? "\n" : "") + shown; part.end = line;
	});
	return { lead, columns };
}
const tone = (status: string) => /waiting|approv|question/i.test(status) ? "waiting" : /block|fail/i.test(status) ? "blocked"
	: /^(idle|closed|watching|offline)/i.test(status) ? "quiet" : "working";
/** Chips in the order they need Jordan: questions first, then problems, work under way, and conversations at rest. */
const RANK = { waiting: 0, blocked: 1, working: 2, quiet: 3 };
/** Secondary agents shown for each conversation before the rest are counted. */
const AGENTS = 3;
const wakeTime = (at: number) => wakeLabel(at).replace(/^Wakes /, "");
/** Home labels a job's watch with the job and the path of its instructions (home-extension.ts); the timeline shows the job. */
const watchTitle = (title: string) => title.replace(/\s*[—:-]\s*\/\S+$/, "") || title;
/** Wakes each timeline shows, nearest first; it scrolls sideways. */
const WAKES = 16;
const TASK = /^(\s*(?:[-*+]|\d+[.)])\s+)\[([ xX])\]/;

/** Changes to the page's lines, made over the file Jordan sees; undefined while it can't be changed. */
interface Editing { lines: string[]; save: (lines: string[]) => void; busy: boolean }
const EditContext = createContext<Editing | undefined>(undefined);
/** The file line of the list item a checkbox belongs to. */
const ItemContext = createContext<number | undefined>(undefined);
/** The file line of the first line of the Markdown being shown. */
const LineContext = createContext(1);

function TaskBox({ checked }: { checked: boolean }) {
	const edit = useContext(EditContext), line = useContext(ItemContext);
	const toggle = () => {
		if (!edit || line === undefined) return;
		const lines = [...edit.lines], task = TASK.exec(lines[line - 1] ?? "");
		if (!task) return;
		lines[line - 1] = task[1] + (task[2] === " " ? "[x]" : "[ ]") + lines[line - 1]!.slice(task[0].length);
		edit.save(lines);
	};
	return <input type="checkbox" checked={checked} disabled={!edit || edit.busy || line === undefined} onChange={toggle} aria-label={checked ? "Mark not done" : "Mark done"} />;
}

function Item({ node, children, className }: ComponentProps<"li"> & ExtraProps) {
	const edit = useContext(EditContext), line = useContext(LineContext);
	const start = node?.position?.start.line, end = node?.position?.end.line;
	const first = start === undefined ? undefined : line + start - 1, last = end === undefined ? undefined : line + end - 1;
	return <ItemContext.Provider value={first}><li className={className}>{children}
		{edit && first !== undefined && last !== undefined && <button type="button" className="home-item-delete" disabled={edit.busy}
			aria-label="Delete" title="Delete" onClick={() => edit.save(edit.lines.filter((_, index) => index < first - 1 || index > last - 1))}>×</button>}
	</li></ItemContext.Provider>;
}
/**
 * The page's lines without the category whose heading is on file line `first`: the heading and the lines under it, up
 * to the next heading, apart from the notes Home keeps in HTML comments. Also how many list items went with it.
 */
export function withoutCategory(lines: readonly string[], first: number): { lines: string[]; items: number } {
	let end = first, fence = false;
	for (; end < lines.length; end++) {
		if (/^\s*(```|~~~)/.test(lines[end]!)) fence = !fence;
		if (!fence && /^#{1,3}\s/.test(lines[end]!)) break;
	}
	const kept: string[] = [];
	let items = 0, comment = false;
	lines.forEach((text, index) => {
		const note = comment || text.includes("<!--");
		if (text.includes("<!--")) comment = !text.slice(text.lastIndexOf("<!--")).includes("-->");
		else if (comment && text.includes("-->")) comment = false;
		if (index < first - 1 || index >= end || note) { kept.push(text); return; }
		if (/^\s*(?:[-*+]|\d+[.)])\s/.test(text)) items++;
	});
	return { lines: kept, items };
}
function Category({ node, children }: ComponentProps<"h3"> & ExtraProps) {
	const edit = useContext(EditContext), line = useContext(LineContext);
	const start = node?.position?.start.line, first = start === undefined ? undefined : line + start - 1;
	const confirmation = useConfirmation(`home-category:${first}`);
	const remove = async () => {
		if (!edit || first === undefined) return;
		const { lines, items } = withoutCategory(edit.lines, first), name = edit.lines[first - 1]!.replace(/^#+\s*/, "");
		// An empty category goes at once; one with tasks only once Jordan has seen what goes with it.
		if (items && !await confirmation.request({ title: "Delete this category?", context: name, accept: "Delete",
			body: <p>Its {items === 1 ? "task goes" : `${items} tasks go`} with it.</p> })) return;
		edit.save(lines);
	};
	return <h3>{children}
		{edit && first !== undefined && <button type="button" className="home-item-delete" disabled={edit.busy}
			aria-label="Delete category" title="Delete category" onClick={() => void remove()}>×</button>}
		{confirmation.dialog}
	</h3>;
}
// Constant, so React updates the rendered page in place rather than replacing elements whose component changed.
const COMPONENTS: Components = {
	a: ({ children, href }) => href ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span>,
	input: ({ type, checked }) => type === "checkbox" ? <TaskBox checked={!!checked} /> : null,
	li: Item,
	h3: Category,
};
const PLUGINS = markdownPlugins();
const pageUrl = (url: string) => markdownUrl(undefined, url);
/** A part of the page; it is parsed again only when its text changes. */
const Text = memo(function Text({ children, line }: { children: string; line: number }) {
	return <LineContext.Provider value={line}><div className="markdown">
		<Markdown remarkPlugins={PLUGINS} urlTransform={pageUrl} components={COMPONENTS}>{children}</Markdown></div></LineContext.Provider>;
});

/** A line Jordan adds to a column, as an open task after the column's last line. */
function AddTask({ after }: { after: number }) {
	const edit = useContext(EditContext), [text, setText] = useState(""), [open, setOpen] = useState(false);
	if (!edit) return null;
	if (!open) return <button type="button" className="home-add" onClick={() => setOpen(true)}>+ Add</button>;
	return <form className="home-add-form" onSubmit={event => {
		event.preventDefault();
		if (!text.trim()) return;
		edit.save([...edit.lines.slice(0, after), "- [ ] " + text.trim(), ...edit.lines.slice(after)]); setText("");
	}}><input autoFocus aria-label="New task" placeholder="New task" value={text} disabled={edit.busy} onChange={event => setText(event.target.value)}
		onKeyDown={event => { if (event.key === "Escape") { setOpen(false); setText(""); } }} onBlur={() => { if (!text.trim()) setOpen(false); }} /></form>;
}

function Wakes({ title, items }: { title: string; items: { key: string; at: number; title: string; hint: string; home: boolean; open: () => void }[] }) {
	if (!items.length) return null;
	return <section className="home-wakes" aria-label={title}><h3>{title}</h3>
		<ol>{items.map(item => <li key={item.key} className={item.home ? "home" : undefined}><button title={item.hint} onClick={item.open}>
			<time>{wakeTime(item.at)}</time><span>{item.title}</span></button></li>)}</ol></section>;
}

/**
 * Home: the live work Desk knows about, then Jordan's tasks file as his page, which the Home conversation keeps and
 * lays out. Each ## section is a column, side by side when there is room and stacked on a phone. Jordan can tick,
 * delete, add and edit lines himself; change saves the whole file over the version shown, and is absent when it can't.
 */
export const HomePage = memo(function HomePage({ page, work, watches, open, openWatches, change }: {
	page: string; work: HomeWork[]; watches: HomeWatch[]; open: (work: HomeWork) => void; openWatches: () => void;
	change?: (text: string) => Promise<void>;
}) {
	const { lead, columns } = useMemo(() => sections(page), [page]), lines = useMemo(() => page.split("\n"), [page]);
	const [busy, setBusy] = useState(false), [draft, setDraft] = useState<string>();
	const save = (text: string) => { if (!change) return; setBusy(true); void change(text).then(() => setDraft(undefined), () => {}).finally(() => setBusy(false)); };
	const editing = useMemo<Editing | undefined>(() => change ? { lines, busy, save: next => save(next.join("\n")) } : undefined, [lines, busy, change]);
	// Secondary agents follow the conversation that started them.
	const now = Date.now(), sameConversation = (a: HomeWork, b: HomeWork) => a.id === b.id && (a.computer ?? "") === (b.computer ?? "");
	// A conversation can run dozens of agents: the first few show, then a count that opens the conversation.
	// A closed conversation a watch will reopen is only on the timeline.
	const chips = work.filter(item => !item.parent && item.status !== "Closed").sort((a, b) => RANK[tone(a.status)] - RANK[tone(b.status)]).flatMap(top => {
		const agents = work.filter(item => item.parent && sameConversation(item, top));
		return [top, ...agents.length > AGENTS + 1 ? [...agents.slice(0, AGENTS), { ...top, title: (agents.length - AGENTS) + " more agents",
			status: "", detail: agents.slice(AGENTS).map(item => item.title + ": " + item.status).join("\n"), parent: top.title, view: undefined }] : agents];
	});
	// Home's own watches, which open its list of watches, apart from other conversations' next wakes.
	const homeWakes = watches.filter(watch => watch.at && watch.at > now - 60_000).sort((a, b) => a.at! - b.at!).slice(0, WAKES)
		.map(watch => ({ key: "home:" + watch.id, at: watch.at!, title: watchTitle(watch.title), hint: "Home's watch " + watch.id + ": " + watch.title, home: true, open: openWatches }));
	const agentWakes = work.filter(item => item.wakes && item.wakes > now - 60_000).sort((a, b) => a.wakes! - b.wakes!).slice(0, WAKES)
		.map(item => ({ key: (item.computer ?? "") + ":" + item.id, at: item.wakes!, title: item.title, hint: "A watch wakes " + item.title, home: false, open: () => open(item) }));
	const hasPage = !!lead.body.trim() || columns.length > 0;
	return <div className="home-canvas"><div className="home-page">
		{chips.length > 0 && <div className="home-live" aria-label="Conversations">{chips.map(item =>
			<button key={(item.computer ?? "") + ":" + item.id + ":" + (item.view ?? (item.parent ? "more" : ""))} className={"home-live-item " + tone(item.status) + (item.parent ? " child" : "")}
				title={[item.parent && "Secondary agent of " + item.parent, item.detail].filter(Boolean).join("\n") || undefined} onClick={() => open(item)}>
				<span className="home-live-dot" /><strong>{item.title}</strong>{item.status && <span>{item.status}</span>}</button>)}</div>}
		{(homeWakes.length > 0 || agentWakes.length > 0) && <div className="home-wake-rows">
			<Wakes title="Home's next wakes" items={homeWakes} /><Wakes title="Agents' next wakes" items={agentWakes} /></div>}
		{draft !== undefined ? <form className="home-edit" onSubmit={event => { event.preventDefault(); save(draft); }}>
			<textarea aria-label="Home's page" spellCheck={false} value={draft} disabled={busy} onChange={event => setDraft(event.target.value)} />
			<div className="home-edit-actions"><button type="submit" disabled={busy || draft === page}>Save</button>
				<button type="button" className="quiet-action" disabled={busy} onClick={() => setDraft(undefined)}>Cancel</button></div>
		</form> : <EditContext.Provider value={editing}>
			{change && <button type="button" className="quiet-action home-edit-page" onClick={() => setDraft(page)}>Edit page</button>}
			{lead.body.trim() && <div className="home-lead"><Text line={lead.line}>{lead.body}</Text></div>}
			{columns.length ? <div className="home-columns">{columns.map((column, index) => {
				// A new task goes after the column's last written line, or under its heading when it has none.
				const written = lines.slice(column.heading, column.end).map((text, at) => text.trim() ? column.heading + at + 1 : 0).filter(Boolean);
				return <section key={index} className="home-column"><h2>{column.title}</h2><Text line={column.line}>{column.body}</Text>
					<AddTask after={written.at(-1) ?? column.heading} /></section>;
			})}</div> : !hasPage && <p className="home-empty muted">No tasks yet.</p>}
		</EditContext.Provider>}
	</div></div>;
});
