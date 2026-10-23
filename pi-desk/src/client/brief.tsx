import Markdown from "react-markdown";
import { markdownPlugins } from "./markdown-links.ts";

/** As pi-compaction-context's brief.ts returns it. */
export type Brief = { markdown: string; created: number; model: string; source: "cache" | "transcript"; reused?: boolean; auto?: boolean;
	usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; cost?: { total: number } } };
/** One conversation's "What do I need to know?": for the reply it covers, being written, written, or failed. */
export type BriefState = { reply: string; working: boolean; brief?: Brief; error?: string };

/** The brief without its "Next steps" section, and that section's bullets: messages the user might send next. */
export function nextSteps(markdown: string): { body: string; steps: string[] } {
	const heading = /^#{1,3}\s*Next steps\s*$/im.exec(markdown);
	if (!heading) return { body: markdown, steps: [] };
	const after = markdown.slice(heading.index + heading[0].length), end = after.search(/^#{1,3}\s/m);
	const section = end < 0 ? after : after.slice(0, end);
	const steps = section.split("\n").flatMap(line => {
		const step = /^\s*(?:[-*+]|\d+[.)])\s+(.*\S)\s*$/.exec(line)?.[1]?.replace(/^["“](.*)["”]$/, "$1");
		return step && !/^none\.?$/i.test(step) ? [step] : [];
	}).slice(0, 3);
	return { body: `${markdown.slice(0, heading.index)}${end < 0 ? "" : after.slice(end)}`.trim(), steps };
}

/** The brief, beside the conversation: what happened compared with what was asked, and how it was written. */
export function BriefView({ brief, working, rewrite }: { brief: Brief; working?: boolean; rewrite?: () => void }) {
	const cost = brief.usage?.cost?.total, { body, steps } = nextSteps(brief.markdown);
	return <>
		<article className="markdown brief-body"><Markdown remarkPlugins={markdownPlugins()}>{body}</Markdown></article>
		{steps.length > 0 && <div className="brief-steps" aria-label="Next steps">
			{/* Puts the message in the message box to edit or send, as Reply does. */}
			{steps.map(step => <button type="button" key={step} className="brief-step" title="Put this in the message box"
				onClick={() => window.dispatchEvent(new CustomEvent("pi-desk:quote", { detail: step }))}>{step}</button>)}
		</div>}
		<footer className="brief-footer">
			<span className="muted">{new Date(brief.created).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}
				{brief.auto ? " · written while you were away" : brief.reused ? " · written earlier" : brief.source === "cache" ? " · from the conversation's cache" : " · from a copy of the conversation"}
				{!brief.reused && cost !== undefined ? ` · $${cost.toFixed(cost < 0.1 ? 3 : 2)}` : ""}</span>
			{rewrite && <button type="button" className="quiet-action" disabled={working} onClick={rewrite}>{working ? "Writing…" : "Write again"}</button>}
		</footer>
	</>;
}
