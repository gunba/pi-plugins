import { useState } from "react";
import type { SessionView } from "../shared/protocol.ts";
import { api } from "./connection.ts";
import { useConfirmation } from "./confirmation.tsx";
import { CloseSummary } from "./close-summary.tsx";

export function CloseConversationButton({ session, name, computer, connected, disabled, icon = false, confirmed, report }: {
	session: SessionView; name: string; computer: string; connected: boolean; disabled?: boolean; icon?: boolean;
	confirmed?: () => void; report: (message: string) => void;
}) {
	const [pending, setPending] = useState(false);
	const closing = session.controls?.some(control => control.kind === "close" && control.state === "running");
	const confirmation = useConfirmation(`${session.key}:${session.activation}:${session.ui?.generation}:${connected}:${!!closing}`);
	const close = async () => {
		if (!session.activation || !connected || disabled || pending || closing) return;
		const sleeping = session.state === "closed" && session.kept;
		const choice = await confirmation.choose(sleeping
			? { title: "Remove conversation?", context: `${computer} · ${name}`, accept: "Remove from sidebar",
				body: <p>It is not running. Its history is kept and can be resumed from Resume.</p> }
			: { title: "Close conversation?", context: `${computer} · ${name}`, accept: "Close and remove", alternative: "Close, keep in sidebar",
				body: <><CloseSummary session={session} /><p className="muted">Keeping it in the sidebar stops Pi to free memory; open it later and choose Resume to carry on.</p></> });
		if (!choice) return;
		setPending(true); confirmed?.();
		try {
			await api(`/sessions/${session.key}/close`, { id: crypto.randomUUID(), activation: session.activation, ...(choice === "alternative" ? { keep: true } : {}) });
		} catch (error) {
			report(`${name}: ${error instanceof Error ? error.message : String(error)}`);
		} finally { setPending(false); }
	};
	return <>
		<button type="button" className={icon ? "icon-button session-close" : "close-conversation"}
			title={!connected ? "Reconnect to close this conversation" : closing || pending ? "Closing conversation…" : session.state === "closed" && session.kept ? "Remove from sidebar" : "Close conversation"}
			aria-label={icon ? `Close ${name}` : "Close conversation"}
			disabled={!session.activation || !connected || disabled || pending || closing}
			onClick={() => void close()}>
			{icon ? <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
				<path d="m6 6 12 12M18 6 6 18" />
			</svg> : closing || pending ? "Closing…" : "Close"}
		</button>
		{confirmation.dialog}
	</>;
}
