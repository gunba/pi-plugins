import { useEffect, useState } from "react";
import { copyDraftAttachments, draftAttachments, type DraftFile } from "./attachments.tsx";

const textKey = (id: string) => `pi-desk:draft:${id}`;
const receiptKey = (id: string) => `pi-desk:submission:${id}`;
interface Draft { id: string; text: string; files: DraftFile[]; uncertain: boolean }

export async function savedDrafts(available: string[]): Promise<Draft[]> {
	const files = await draftAttachments(), keys = new Set(files.keys());
	for (const key of Object.keys(localStorage)) if (key.startsWith("pi-desk:draft:")) keys.add(key.slice("pi-desk:draft:".length));
	return [...keys].filter(key => !available.includes(key)).map(id => ({
		id, text: localStorage.getItem(textKey(id)) ?? "", files: files.get(id) ?? [], uncertain: !!localStorage.getItem(receiptKey(id)),
	})).filter(draft => draft.text || draft.files.length);
}
export async function restoreDraft(source: string, target: string): Promise<string> {
	let copied = "";
	await copyDraftAttachments(source, target, () => {
		if (localStorage.getItem(textKey(target)) || localStorage.getItem(receiptKey(target))) {
			throw new Error("The current draft is not empty. Save or clear it before copying another draft.");
		}
		copied = localStorage.getItem(textKey(source)) ?? "";
		const previous = localStorage.getItem(receiptKey(source));
		const receipt = previous ? JSON.stringify({ ...JSON.parse(previous), requiresConfirmation: true }) : undefined;
		const rollback = () => {
			if (localStorage.getItem(textKey(target)) === copied) localStorage.removeItem(textKey(target));
			if (receipt && localStorage.getItem(receiptKey(target)) === receipt) localStorage.removeItem(receiptKey(target));
		};
		try {
			if (receipt) localStorage.setItem(receiptKey(target), receipt);
			localStorage.setItem(textKey(target), copied);
		} catch (error) { rollback(); throw error; }
		return rollback;
	});
	return copied;
}
function Download({ file }: { file: DraftFile }) {
	const [url, setUrl] = useState("");
	useEffect(() => {
		const url = URL.createObjectURL(file.blob); setUrl(url);
		return () => URL.revokeObjectURL(url);
	}, [file.blob]);
	return <a href={url || undefined} download={file.name}>{file.name}</a>;
}
export function DraftRecovery({ available, target, busy, restored }: {
	available: string[]; target?: string; busy: boolean; restored: (target: string, text: string) => void;
}) {
	const [drafts, setDrafts] = useState<Draft[]>([]), [error, setError] = useState(""), [working, setWorking] = useState(false);
	const scope = JSON.stringify(available);
	useEffect(() => {
		let active = true;
		void savedDrafts(available).then(value => { if (active) setDrafts(value); })
			.catch(error => { if (active) setError(String(error)); });
		return () => { active = false; };
	}, [scope]);
	if (!drafts.length && !error) return null;
	return <section className="panel-card">
		<h3>Saved drafts</h3>
		<p className="muted">Drafts from conversations not currently listed. Copying keeps the original and sends nothing.</p>
		{drafts.map(draft => <details key={draft.id}>
			<summary>{draft.text.slice(0, 70) || draft.files[0]?.name || "Draft"}</summary>
			<small>{draft.id || "Unassigned draft"}</small>
			{draft.text && <pre className="confirmation-preview">{draft.text}</pre>}
			{draft.files.map(file => <p key={file.id}><Download file={file} /></p>)}
			{draft.uncertain && <p className="muted">An earlier delivery was not confirmed. Check its conversation before sending again.</p>}
			<button disabled={!target || busy || working} onClick={() => {
				if (!target) return;
				setWorking(true); setError("");
				void restoreDraft(draft.id, target).then(text => restored(target, text))
					.catch(error => setError(error instanceof Error ? error.message : String(error))).finally(() => setWorking(false));
			}}>Copy to current conversation</button>
		</details>)}
		{!target && <p className="muted">Select a conversation to restore a draft, or download its files here.</p>}
		{error && <p role="alert" className="error-text">{error}</p>}
	</section>;
}
