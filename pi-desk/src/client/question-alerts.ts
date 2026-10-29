import { useEffect, useRef } from "react";
import type { SessionView } from "../shared/protocol.ts";

/**
 * A conversation that waits for an answer (a command guard confirmation, an agent's question) must reach the
 * user wherever they are: the window title counts open questions, and each new one posts a system notification
 * unless it is already on screen. Clicking the notification opens its conversation (public/sw.js, notice-links.ts).
 * Notifications are posted through the service worker: Android's browser has no `new Notification()`.
 */
export function useQuestionAlerts(sessions: readonly SessionView[] | undefined, selected: string,
	name: (session: SessionView) => string): void {
	const pending = (sessions ?? []).flatMap(session => (session.ui?.interactions ?? [])
		.filter(item => !item.settings).map(item => ({ session, item })));
	const seen = useRef(new Set<string>()), shown = useRef(new Set<string>());
	const ids = pending.map(({ session, item }) => `${session.key}/${item.id}`).join("\n");
	useEffect(() => () => { for (const id of shown.current) close(id); }, []);
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
		for (const id of shown.current) if (!live.has(id)) { close(id); shown.current.delete(id); }
		if (typeof Notification === "undefined" || !navigator.serviceWorker) return;
		for (const { session, item } of pending) {
			const id = `${session.key}/${item.id}`;
			if (seen.current.has(id)) continue;
			seen.current.add(id);
			if (session.key === selected && document.visibilityState === "visible" && document.hasFocus()) continue;
			const show = () => {
				const minutes = item.deadline ? Math.max(1, Math.round((item.deadline - Date.now()) / 60_000)) : undefined;
				const body = [item.form.kind === "confirm" ? item.form.message.split("\n")[0] : "",
					minutes ? `No answer within ${minutes} minute${minutes === 1 ? "" : "s"} counts as no.` : ""].filter(Boolean).join("\n");
				const title = `${name(session)}: ${item.form.title}`;
				void navigator.serviceWorker.ready.then(registration => {
					if (!seen.current.has(id)) return;
					shown.current.add(id);
					return registration.showNotification(title, { body, tag: id, requireInteraction: true, data: { session: session.key } });
				}).catch(() => {});
			};
			if (Notification.permission === "granted") show();
			else if (Notification.permission === "default") void Notification.requestPermission().then(result => { if (result === "granted") show(); });
		}
	}, [ids, selected]);
}

function close(tag: string): void {
	void navigator.serviceWorker?.ready.then(registration => registration.getNotifications({ tag }))
		.then(notices => { for (const notice of notices ?? []) notice.close(); }).catch(() => {});
}

/** Notification permission needs a click in some browsers: ask once, on the first click anywhere. */
export function askForNotificationsOnFirstClick(): void {
	if (typeof Notification === "undefined" || Notification.permission !== "default") return;
	const ask = () => { if (Notification.permission === "default") void Notification.requestPermission(); };
	window.addEventListener("pointerdown", ask, { once: true, capture: true });
}
