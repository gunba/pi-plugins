import { useState } from "react";
import { FolderField } from "./folder-picker.tsx";
import { Modal } from "./surfaces.tsx";
import type { Computer } from "./workspace.ts";

/**
 * What is being moved: a conversation, the computer it is on, and where it ran there. A move that failed comes back
 * with the computer and folder that were chosen, and why it failed.
 */
export type MoveRequest = { source: Computer; session: string; title: string; cwd: string; target?: string; folder?: string; error?: string };

/**
 * "Move to another computer": the conversation continues on the chosen computer, in the chosen folder, with its whole
 * history. From its own computer when that is on (where it then stops), otherwise from the copy another computer keeps.
 * Files it worked on are not moved: the folder chosen should hold them. The window only chooses: `start` makes the
 * move, which can take minutes for a long conversation, while Desk stays usable.
 */
export function MoveConversation({ request, computers, close, start }: {
	request: MoveRequest; computers: Computer[]; close: () => void; start: (target: string, folder: string) => void;
}) {
	const { source } = request;
	const targets = computers.filter(computer => computer.id !== source.id && computer.connected && computer.teleport);
	const folderOn = (computer?: Computer) => !computer ? "" : computer.platform && computer.platform === source.platform ? request.cwd : computer.cwd;
	const first = targets.find(computer => computer.id === request.target) ?? targets[0];
	const [target, setTarget] = useState(first?.id ?? ""), chosen = targets.find(computer => computer.id === target);
	const [folder, setFolder] = useState(request.target === first?.id && request.folder ? request.folder : folderOn(first));
	const sourceOn = source.connected && source.loaded !== false;
	return <Modal title="Move to another computer" className="move-modal" close={close}>
		<form className="move-form" onSubmit={event => { event.preventDefault(); if (target && folder.trim()) start(target, folder.trim()); }}>
			<p>“{request.title}” continues on the computer you choose, with its whole history. {sourceOn
				? `It stops on ${source.name}.` : `${source.name} is off, so the copy another computer keeps is used.`}</p>
			{targets.length ? <>
				<label>Computer
					<select value={target} onChange={event => { setTarget(event.target.value); setFolder(folderOn(targets.find(computer => computer.id === event.target.value))); }}>
						{targets.map(computer => <option key={computer.id} value={computer.id}>{computer.name}</option>)}
					</select></label>
				<FolderField key={target} value={folder} onChange={setFolder} computer={target} label={`Folder on ${chosen?.name ?? "that computer"}`} />
				<p className="muted">The files it worked on are not moved: choose the folder that holds them on {chosen?.name ?? "that computer"}. It was in {request.cwd} on {source.name}.</p>
			</> : <p className="muted">No other computer that can take it is on. Update Desk on your other computers, or turn one on.</p>}
			{request.error && <p className="error-text" role="alert">{request.error}</p>}
			<div className="move-actions">
				<button type="button" className="quiet-action" onClick={close}>Cancel</button>
				<button type="submit" className="primary" disabled={!target || !folder.trim()}>Move</button>
			</div>
		</form>
	</Modal>;
}
