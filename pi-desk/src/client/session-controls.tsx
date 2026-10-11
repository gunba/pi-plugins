import { useState } from "react";
import type { TreePage, WorkerCommand } from "../shared/protocol.ts";
import { isControl } from "../shared/controls.ts";
import { Icon } from "./icons.tsx";

type Entry = TreePage["entries"][number];
/** Points worth returning to: your messages and earlier summaries, not Pi's internal records. */
const meaningful = (entry: Entry) => entry.label.startsWith("user:") || entry.type === "compaction" || entry.type === "branch_summary";
const entryText = (entry: Entry) => entry.label.startsWith("user:") ? entry.label.slice(5).trim() || "(empty message)"
	: entry.type === "compaction" ? "Context compacted" : "Branch summary";

export function SessionControls({ generation, busy, invoke }: {
	generation: string; busy: boolean; invoke: (command: WorkerCommand) => Promise<unknown>;
}) {
	const [tree, setTree] = useState<TreePage>();
	const [error, setError] = useState("");
	const [working, setWorking] = useState(false);
	const [summary, setSummary] = useState(false);
	const [instructions, setInstructions] = useState("");
	const run = async (command: WorkerCommand) => {
		setWorking(true); setError("");
		try {
			const { result } = await invoke(command) as { result: TreePage };
			if (command.kind === "tree") setTree(previous => command.after && previous?.generation === result.generation
				? { ...result, entries: [...previous.entries, ...result.entries] } : result);
		} catch (error) { setError(`${error instanceof Error ? error.message : String(error)}${isControl(command) ? " Check Recent operations before trying again." : ""}`); }
		finally { setWorking(false); }
	};
	const points = tree?.generation === generation ? tree.entries.filter(meaningful) : undefined;
	return <>
		{error && <p className="error-text" role="alert">{error}</p>}
		<section className="panel-card">
			<h3>Compact context</h3>
			<p className="muted">Replace earlier messages with a summary to free context. Recent messages are kept word for word.</p>
			<label className="settings-field">Instructions for the summary (optional)
				<textarea value={instructions} placeholder="What should the summary keep?" onChange={event => setInstructions(event.target.value)} rows={2} /></label>
			<button disabled={busy || working} onClick={() => void run({ kind: "compact", instructions })}><Icon name="layers" />Compact now</button>
		</section>
		<section className="panel-card">
			<h3>Branches</h3>
			<p className="muted">Go back to one of your earlier messages and continue from there, or copy the conversation up to that point into a new one. Nothing is deleted.</p>
			{!points ? <button disabled={busy || working} onClick={() => void run({ kind: "tree" })}>Show earlier messages</button> : <>
				<label className="check-row"><input type="checkbox" checked={summary} onChange={event => setSummary(event.target.checked)} />Summarise the part you leave behind</label>
				{points.length ? <ol className="branch-points">{points.map(entry => <li key={entry.id}>
					<div><span>{entryText(entry)}</span><small>{new Date(entry.timestamp).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
						{tree!.leaf === entry.id ? " · current" : ""}</small></div>
					<div className="branch-actions">
						<button disabled={busy || working} title="Continue the conversation from this point" onClick={() => void run({ kind: "navigate", entry: entry.id, summarize: summary })}>Continue here</button>
						<button disabled={busy || working} title="Copy the conversation up to this point into a new conversation" onClick={() => void run({ kind: "fork", entry: entry.id, position: "at" })}>New from here</button>
						{entry.label.startsWith("user:") && <button disabled={busy || working} title="Start a new conversation just before this message, with it in the composer to edit"
							onClick={() => void run({ kind: "fork", entry: entry.id, position: "before" })}>Edit & resend</button>}
					</div>
				</li>)}</ol> : <p className="muted">No earlier messages in this part of the history.</p>}
				{tree!.next && <button className="quiet-action" disabled={working} onClick={() => void run({ kind: "tree", after: tree!.next })}>Load more</button>}
			</>}
		</section>
	</>;
}
