import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import { markdownPlugins } from "./markdown-links.ts";
import { Modal } from "./surfaces.tsx";

/** As pi-compaction-context's brief.ts returns it. */
export type Brief = { markdown: string; created: number; model: string; source: "cache" | "transcript"; reused?: boolean;
	usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; cost?: { total: number } } };

/** "What do I need to know?": the agent's brief on its latest turn, written outside the conversation. */
export function BriefModal({ write, close }: { write: (refresh: boolean) => Promise<Brief>; close: () => void }) {
	const [brief, setBrief] = useState<Brief>(), [error, setError] = useState(""), [working, setWorking] = useState(false);
	const alive = useRef(true);
	const run = (refresh: boolean) => {
		setWorking(true); setError("");
		write(refresh).then(value => { if (alive.current) setBrief(value); }, failure => { if (alive.current) setError(failure instanceof Error ? failure.message : String(failure)); })
			.finally(() => { if (alive.current) setWorking(false); });
	};
	useEffect(() => { alive.current = true; run(false); return () => { alive.current = false; }; }, []);
	const cost = brief?.usage?.cost?.total;
	return <Modal title="What do I need to know?" className="brief-modal" close={close}>
		{working && !brief && <p className="muted">Writing the brief from the conversation…</p>}
		{error && <p className="error-text" role="alert">{error}</p>}
		{brief && <article className="markdown brief-body"><Markdown remarkPlugins={markdownPlugins()}>{brief.markdown}</Markdown></article>}
		{brief && <footer className="brief-footer">
			<span className="muted">{new Date(brief.created).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}
				{brief.reused ? " · written earlier" : brief.source === "cache" ? " · from the conversation's cache" : " · from a copy of the conversation"}
				{!brief.reused && cost !== undefined ? ` · $${cost.toFixed(cost < 0.1 ? 3 : 2)}` : ""}</span>
			<button type="button" className="quiet-action" disabled={working} onClick={() => run(true)}>{working ? "Writing…" : "Write again"}</button>
		</footer>}
	</Modal>;
}
