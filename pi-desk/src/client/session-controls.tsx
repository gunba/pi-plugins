import { useEffect, useState } from "react";
import type { TreePage, WorkerCommand } from "../shared/protocol.ts";
import { isControl } from "../shared/controls.ts";

export function SessionControls({ generation, busy, invoke }: {
	generation: string; busy: boolean; invoke: (command: WorkerCommand) => Promise<unknown>;
}) {
	const [tree, setTree] = useState<TreePage>();
	const [error, setError] = useState("");
	const [working, setWorking] = useState(false);
	const [summary, setSummary] = useState(false);
	const [instructions, setInstructions] = useState("");
	useEffect(() => { setTree(undefined); void run({ kind: "tree" }); }, [generation]);
	const run = async (command: WorkerCommand) => {
		setWorking(true); setError("");
		try {
			const { result } = await invoke(command) as { result: TreePage };
			if (command.kind === "tree") setTree(previous => command.after && previous?.generation === result.generation
				? { ...result, entries: [...previous.entries, ...result.entries] } : result);
		} catch (error) { setError(`${error instanceof Error ? error.message : String(error)}${isControl(command) ? " Check Recent operations before trying again." : ""}`); }
		finally { setWorking(false); }
	};
	return <section className="panel-card">
		<h3>History & context</h3>
		{error && <p className="error-text" role="alert">{error}</p>}
		<button disabled={busy || working} onClick={() => void run({ kind: "tree" })}>Browse branches</button>
		{tree && <>
			<label className="check-row"><input type="checkbox" checked={summary} onChange={event => setSummary(event.target.checked)} />Summarize the branch being left</label>
			<p className="muted">Continue after an entry, or fork a separate session from that point. Existing branches are kept.</p>
			<div className="tree-list">{tree.entries.map(entry => <article key={entry.id} className="history-item">
				<strong>{entry.label || entry.type}{tree.leaf === entry.id ? " · current" : ""}</strong>
				<small>{entry.id} ← {entry.parentId ?? "start"}</small>
				<div className="panel-actions">
					<button disabled={busy || working} onClick={() => void run({ kind: "navigate", entry: entry.id, summarize: summary })}>Continue here</button>
					<button disabled={busy || working} onClick={() => void run({ kind: "fork", entry: entry.id, position: "at" })}>Fork here</button>
					{entry.label.startsWith("user:") && <button disabled={busy || working} onClick={() => void run({ kind: "fork", entry: entry.id, position: "before" })}>Fork & edit</button>}
				</div>
			</article>)}</div>
			{tree.next && <button disabled={working} onClick={() => void run({ kind: "tree", after: tree.next })}>More entries</button>}
		</>}
		<label>Compaction instructions<textarea value={instructions} placeholder="What should the summary preserve?"
			onChange={event => setInstructions(event.target.value)} rows={2} /></label>
		<button disabled={busy || working} onClick={() => void run({ kind: "compact", instructions })}>Compact context</button>
	</section>;
}
