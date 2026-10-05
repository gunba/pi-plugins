import { useState } from "react";
import { api, ApiError } from "./connection.ts";
import { Modal } from "./surfaces.tsx";
import type { SessionView } from "../shared/protocol.ts";
import type { InputStatus, InputSubmission, PromptCommand } from "../shared/inputs.ts";

const labels: Record<InputStatus["state"], string> = {
	queued: "Waiting for Pi", sending: "Confirming admission", accepted: "Sent to Pi",
	cancelled: "Cancelled", failed: "Could not send", interrupted: "Delivery unconfirmed",
};
export function PendingInputs({ session, connected, report }: {
	session: SessionView; connected: boolean; report: (error: string) => void;
}) {
	const [review, setReview] = useState<{ status: InputStatus; command?: PromptCommand }>();
	const [working, setWorking] = useState(false);
	const [changed, setChanged] = useState(false);
	const invoke = async (operation: () => Promise<void>) => {
		setWorking(true);
		try { await operation(); } catch (error) { report(error instanceof Error ? error.message : String(error)); }
		finally { setWorking(false); }
	};
	const resend = async (fresh = false) => {
		if (!review?.command || !session.activation) return;
		const receiptKey = `pi-desk:input-retry:${session.key}:${review.status.id}`;
		const previous = fresh ? null : JSON.parse(localStorage.getItem(receiptKey) ?? "null") as InputSubmission | null;
		const input: InputSubmission = previous ?? {
			id: crypto.randomUUID(), activation: session.activation,
			generation: session.state === "starting" ? undefined : session.ui?.generation,
			command: { ...review.command, behavior: review.command.behavior ?? "steer" },
		};
		localStorage.setItem(receiptKey, JSON.stringify(input));
		try { await api(`/sessions/${session.key}/inputs`, input); }
		catch (error) {
			if (error instanceof ApiError && error.status === 409) setChanged(true);
			throw error;
		}
		await api(`/sessions/${session.key}/inputs/${review.status.id}/dismiss`, {});
		localStorage.removeItem(receiptKey);
		setReview(undefined); setChanged(false);
	};
	if (!session.inputs?.length && !review) return null;
	return <>
		<section className="pending-inputs" aria-label="Pending messages">
			{session.inputs?.map(input => <div className="pending-input" key={input.id}>
				<div><strong>{labels[input.state]}{input.files > 0 && ` · ${input.files} file${input.files === 1 ? "" : "s"}`}</strong>
					<p>{input.preview || `${input.files} attachment${input.files === 1 ? "" : "s"}`}</p>
					{input.error && <small>{input.error}</small>}</div>
				{input.state === "queued" ? <button disabled={!connected || working} onClick={() => void invoke(async () => {
					await api(`/sessions/${session.key}/inputs/${input.id}/cancel`, {});
				})}>Cancel</button> : input.state === "sending" ? <small>Check the conversation before repeating this message.</small>
					: <button disabled={!connected || working} onClick={() => void invoke(async () => {
						setReview(await api(`/sessions/${session.key}/inputs/${input.id}`)); setChanged(false);
					})}>Review</button>}
			</div>)}
		</section>
		{review && <Modal title="Review message" close={() => { if (!working) setReview(undefined); }}>
			<p>{review.status.error}</p>
			{review.status.state === "interrupted" && <p>Check the saved conversation before sending again. Pi may already have received this message.</p>}
			<pre className="confirmation-preview">{review.command?.text}</pre>
			{!!review.command?.attachments?.length && <p>{review.command.attachments.length} file{review.command.attachments.length === 1 ? "" : "s"} retained on this computer.</p>}
			{changed && <p role="alert">The session or earlier receipt changed. Check its history and pending messages before starting a new attempt.</p>}
			<div className="panel-actions">
				<button disabled={working || !connected || !review.command || !["starting", "ready"].includes(session.state)}
					onClick={() => void invoke(() => resend(changed))}>{changed ? "Send as a new message" : "Send again"}</button>
				<button disabled={working || !connected} onClick={() => void invoke(async () => {
					await api(`/sessions/${session.key}/inputs/${review.status.id}/dismiss`, {});
					setReview(undefined);
				})}>Discard message</button>
			</div>
			{!["starting", "ready"].includes(session.state) && <p>Start or resume the conversation before sending again.</p>}
		</Modal>}
	</>;
}
