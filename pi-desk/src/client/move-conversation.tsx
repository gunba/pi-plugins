import { useState } from "react";
import { Modal } from "./surfaces.tsx";
import { api } from "./connection.ts";
import type { Computer } from "./workspace.ts";

/** What is being moved: a conversation, the computer it is on, and where it ran there. */
export type MoveRequest = { source: Computer; session: string; title: string; cwd: string };

/**
 * "Move to another computer": the conversation continues on the chosen computer, in the chosen folder, with its whole
 * history. From its own computer when that is on (where it then stops), otherwise from the copy another computer keeps.
 * Files it worked on are not moved: the folder chosen should hold them.
 */
export function MoveConversation({ request, computers, close, moved }: {
	request: MoveRequest; computers: Computer[]; close: () => void; moved: (computer: string, key: string) => void;
}) {
	const { source } = request;
	const targets = computers.filter(computer => computer.id !== source.id && computer.connected && computer.teleport);
	const folderOn = (computer?: Computer) => !computer ? "" : computer.platform && computer.platform === source.platform ? request.cwd : computer.cwd;
	const [target, setTarget] = useState(targets[0]?.id ?? ""), chosen = targets.find(computer => computer.id === target);
	const [folder, setFolder] = useState(folderOn(targets[0])), [busy, setBusy] = useState(false), [error, setError] = useState("");
	// Its file and shell tools can stay on its computer, acting in the folder it was in, while it runs on the chosen one.
	const [keep, setKeep] = useState(false);
	const sourceOn = source.connected && source.loaded !== false;
	const submit = async () => {
		setBusy(true); setError("");
		try {
			const result = await api<{ key: string }>("/teleport/move", { computer: source.id, session: request.session, cwd: folder.trim(), ...(keep ? { hands: true } : {}) }, target);
			moved(target, result.key); close();
		} catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); setBusy(false); }
	};
	return <Modal title="Move to another computer" className="move-modal" close={close}>
		<form className="move-form" onSubmit={event => { event.preventDefault(); void submit(); }}>
			<p>“{request.title}” continues on the computer you choose, with its whole history. {sourceOn
				? `It stops on ${source.name}.` : `${source.name} is off, so the copy another computer keeps is used.`}</p>
			{targets.length ? <>
				<label>Computer
					<select value={target} disabled={busy} onChange={event => { const next = targets.find(computer => computer.id === event.target.value); setTarget(event.target.value); setFolder(keep ? next?.cwd ?? "" : folderOn(next)); }}>
						{targets.map(computer => <option key={computer.id} value={computer.id}>{computer.name}</option>)}
					</select></label>
				{source.connected && <label className="move-keep"><input type="checkbox" checked={keep} disabled={busy}
					onChange={event => { setKeep(event.target.checked); setFolder(event.target.checked ? chosen?.cwd ?? "" : folderOn(chosen)); }} />
					Keep working in {request.cwd} on {source.name}</label>}
				<label>{keep ? `Folder on ${chosen?.name ?? "that computer"} for its other tools` : `Folder on ${chosen?.name ?? "that computer"}`}
					<input value={folder} disabled={busy} onChange={event => setFolder(event.target.value)} spellCheck={false} /></label>
				<p className="muted">{keep
					? `Its read, write, edit and bash tools keep acting in ${request.cwd} on ${source.name}, which must be on for them to work. Everything else, such as codemode, watches and the agents it starts, runs on ${chosen?.name ?? "that computer"}. Moving it back without this option returns it to the way it was.`
					: `The files it worked on are not moved: choose the folder that holds them on ${chosen?.name ?? "that computer"}. It was in ${request.cwd} on ${source.name}.`}</p>
			</> : <p className="muted">No other computer that can take it is on. Update Desk on your other computers, or turn one on.</p>}
			{error && <p className="error-text" role="alert">{error}</p>}
			<div className="move-actions">
				<button type="button" className="quiet-action" onClick={close} disabled={busy}>Cancel</button>
				<button type="submit" className="primary" disabled={!target || !folder.trim() || busy}>{busy ? "Moving…" : "Move"}</button>
			</div>
		</form>
	</Modal>;
}
