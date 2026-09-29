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
		if (!await confirmation.request({
			title: "Close conversation?", context: `${computer} · ${name}`, accept: "Close conversation",
			body: <CloseSummary session={session} />,
		})) return;
		setPending(true); confirmed?.();
		try {
			await api(`/sessions/${session.key}/close`, { id: crypto.randomUUID(), activation: session.activation });
		} catch (error) {
			report(`${name}: ${error instanceof Error ? error.message : String(error)}`);
		} finally { setPending(false); }
	};
	return <>
		<button type="button" className={icon ? "icon-button session-close" : "close-conversation"}
			title={!connected ? "Reconnect to close this conversation" : closing || pending ? "Closing conversation…" : "Close conversation"}
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
