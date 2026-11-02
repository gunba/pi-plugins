import Markdown from "react-markdown";
import type { HomeWork } from "../shared/home.ts";
import { wakeLabel } from "./activity.ts";
import { markdownPlugins, markdownUrl } from "./markdown-links.ts";

/** The page split at its ## headings: what comes before the first spans the page, and each section is a column. */
function sections(page: string): { lead: string; columns: { title: string; body: string }[] } {
	const columns: { title: string; body: string }[] = [], lead: string[] = [];
	let fence = false;
	// Notes the agent keeps for itself sit in HTML comments, which the page doesn't show.
	for (const line of page.replace(/<!--[\s\S]*?-->/g, "").split("\n")) {
		if (/^\s*(```|~~~)/.test(line)) fence = !fence;
		const heading = !fence && /^##\s+(.*)$/.exec(line);
		if (heading) columns.push({ title: heading[1]!.trim(), body: "" });
		else if (columns.length) columns.at(-1)!.body += `${line}\n`;
		else lead.push(line);
	}
	return { lead: lead.join("\n").replace(/^#\s+.*$/m, "").trim(), columns };
}
const tone = (status: string) => /waiting|approv|question/i.test(status) ? "waiting" : /block|fail/i.test(status) ? "blocked"
	: /^(idle|closed|watching|offline)/i.test(status) ? "quiet" : "working";
/** Chips in the order they need Jordan: questions first, then problems, work under way, and conversations at rest. */
const RANK = { waiting: 0, blocked: 1, working: 2, quiet: 3 };
/** Secondary agents shown for each conversation before the rest are counted. */
const AGENTS = 3;
const wakeTime = (at: number) => wakeLabel(at).replace(/^Wakes /, "");
function Text({ children }: { children: string }) {
	return <div className="markdown"><Markdown remarkPlugins={markdownPlugins()} urlTransform={url => markdownUrl(undefined, url)}
		components={{ a: ({ children: label, href }) => href ? <a href={href} target="_blank" rel="noopener noreferrer">{label}</a> : <span>{label}</span> }}>{children}</Markdown></div>;
}

/**
 * Home: the live work Desk knows about, then Jordan's tasks file as his page, which the Home conversation keeps and
 * lays out. Each ## section is a column, side by side when there is room and stacked on a phone.
 */
export function HomePage({ page, work, open }: { page: string; work: HomeWork[]; open: (work: HomeWork) => void }) {
	const { lead, columns } = sections(page);
	// Secondary agents follow the conversation that started them.
	const now = Date.now(), sameConversation = (a: HomeWork, b: HomeWork) => a.id === b.id && (a.computer ?? "") === (b.computer ?? "");
	// A conversation can run dozens of agents: the first few show, then a count that opens the conversation.
	// A closed conversation a watch will reopen is only on the timeline.
	const chips = work.filter(item => !item.parent && item.status !== "Closed").sort((a, b) => RANK[tone(a.status)] - RANK[tone(b.status)]).flatMap(top => {
		const agents = work.filter(item => item.parent && sameConversation(item, top));
		return [top, ...agents.length > AGENTS + 1 ? [...agents.slice(0, AGENTS), { ...top, title: `${agents.length - AGENTS} more agents`,
			status: "", detail: agents.slice(AGENTS).map(item => `${item.title}: ${item.status}`).join("\n"), parent: top.title, view: undefined }] : agents];
	});
	const wakes = work.filter(item => item.wakes && item.wakes > now - 60_000).sort((a, b) => a.wakes! - b.wakes!).slice(0, 12);
	return <div className="home-canvas"><div className="home-page">
		{chips.length > 0 && <div className="home-live" aria-label="Conversations">{chips.map(item =>
			<button key={`${item.computer ?? ""}:${item.id}:${item.view ?? (item.parent ? "more" : "")}`} className={`home-live-item ${tone(item.status)}${item.parent ? " child" : ""}`}
				title={[item.parent && `Secondary agent of ${item.parent}`, item.detail].filter(Boolean).join("\n") || undefined} onClick={() => open(item)}>
				<span className="home-live-dot" /><strong>{item.title}</strong>{item.status && <span>{item.status}</span>}</button>)}</div>}
		{wakes.length > 0 && <section className="home-wakes" aria-labelledby="home-wakes-title"><h3 id="home-wakes-title">Next wakes</h3>
			<ol>{wakes.map(item => <li key={`${item.computer ?? ""}:${item.id}`}><button title={`A watch wakes ${item.title}`} onClick={() => open(item)}>
				<time>{wakeTime(item.wakes!)}</time><span>{item.title}</span></button></li>)}</ol></section>}
		{lead && <div className="home-lead"><Text>{lead}</Text></div>}
		{columns.length ? <div className="home-columns">{columns.map((column, index) =>
			<section key={index} className="home-column"><h2>{column.title}</h2><Text>{column.body}</Text></section>)}</div>
			: !lead && <p className="home-empty muted">No tasks yet.</p>}
	</div></div>;
}
