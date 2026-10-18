import Markdown from "react-markdown";
import { markdownPlugins } from "./markdown-links.ts";

/** As pi-compaction-context's brief.ts returns it. */
export type Brief = { markdown: string; created: number; model: string; source: "cache" | "transcript"; reused?: boolean;
	usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; cost?: { total: number } } };
/** One conversation's "What do I need to know?": for the reply it covers, being written, written, or failed. */
export type BriefState = { reply: string; working: boolean; brief?: Brief; error?: string };

/** The brief, beside the conversation: what happened compared with what was asked, and how it was written. */
export function BriefView({ brief, working, rewrite }: { brief: Brief; working?: boolean; rewrite?: () => void }) {
	const cost = brief.usage?.cost?.total;
	return <>
		<article className="markdown brief-body"><Markdown remarkPlugins={markdownPlugins()}>{brief.markdown}</Markdown></article>
		<footer className="brief-footer">
			<span className="muted">{new Date(brief.created).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}
				{brief.reused ? " · written earlier" : brief.source === "cache" ? " · from the conversation's cache" : " · from a copy of the conversation"}
				{!brief.reused && cost !== undefined ? ` · $${cost.toFixed(cost < 0.1 ? 3 : 2)}` : ""}</span>
			{rewrite && <button type="button" className="quiet-action" disabled={working} onClick={rewrite}>{working ? "Writing…" : "Write again"}</button>}
		</footer>
	</>;
}
