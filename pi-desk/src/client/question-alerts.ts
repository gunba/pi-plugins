import { useEffect, useRef } from "react";
import type { SessionView } from "../shared/protocol.ts";

/**
 * A conversation that waits for an answer (a command guard confirmation, an agent's question) must reach the
 * user wherever they are: the window title counts open questions, and each new one posts a system notification
 * unless it is already on screen. Clicking the notification opens its conversation.
 */
export function useQuestionAlerts(sessions: readonly SessionView[] | undefined, selected: string,
	open: (key: string) => void, name: (session: SessionView) => string): void {
	const pending = (sessions ?? []).flatMap(session => (session.ui?.interactions ?? [])
		.filter(item => !item.settings).map(item => ({ session, item })));
	const seen = useRef(new Set<string>()), shown = useRef(new Map<string, Notification>());
	const openRef = useRef(open); openRef.current = open;
	const ids = pending.map(({ session, item }) => `${session.key}/${item.id}`).join("\n");
	useEffect(() => () => { for (const notice of shown.current.values()) notice.close(); }, []);
	useEffect(() => {
		if (!pending.length) return;
		const previous = document.title;
		document.title = `(${pending.length}) Needs your answer · Pi Desk`;
		return () => { document.title = previous; };
	}, [pending.length]);
	useEffect(() => {
		const live = new Set(ids ? ids.split("\n") : []);
		for (const id of seen.current) if (!live.has(id)) seen.current.delete(id);
		// A question answered, cancelled or timed out takes its notification with it.
		for (const [id, notice] of shown.current) if (!live.has(id)) { notice.close(); shown.current.delete(id); }
		if (typeof Notification === "undefined") return;
		for (const { session, item } of pending) {
			const id = `${session.key}/${item.id}`;
			if (seen.current.has(id)) continue;
			seen.current.add(id);
			if (session.key === selected && document.visibilityState === "visible" && document.hasFocus()) continue;
			const show = () => {
				const minutes = item.deadline ? Math.max(1, Math.round((item.deadline - Date.now()) / 60_000)) : undefined;
				const body = [item.form.kind === "confirm" ? item.form.message.split("\n")[0] : "",
					minutes ? `No answer within ${minutes} minute${minutes === 1 ? "" : "s"} counts as no.` : ""].filter(Boolean).join("\n");
				if (!seen.current.has(id)) return;
				const notice = new Notification(`${name(session)}: ${item.form.title}`, { body, tag: id, requireInteraction: true });
				notice.onclick = () => { window.focus(); openRef.current(session.key); notice.close(); };
				notice.onclose = () => { shown.current.delete(id); };
				shown.current.set(id, notice);
			};
			if (Notification.permission === "granted") show();
			else if (Notification.permission === "default") void Notification.requestPermission().then(result => { if (result === "granted") show(); });
		}
	}, [ids, selected]);
}

/** Notification permission needs a click in some browsers: ask once, on the first click anywhere. */
export function askForNotificationsOnFirstClick(): void {
	if (typeof Notification === "undefined" || Notification.permission !== "default") return;
	const ask = () => { if (Notification.permission === "default") void Notification.requestPermission(); };
	window.addEventListener("pointerdown", ask, { once: true, capture: true });
}
