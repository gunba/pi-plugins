import { useEffect, useRef, useState } from "react";
import { api } from "./connection.ts";
import type { SessionView } from "../shared/protocol.ts";
import type { WorkspaceState } from "./workspace.ts";
import type { UiAnswer } from "../../../pi-ui/index.ts";

interface Notice { type: "notice"; session?: string; answer?: { interaction: string; answer: UiAnswer }; at: number }
/** How long a notification's click waits for its conversation to arrive after the app opens. */
const WAIT_MS = 60_000;

/**
 * A notification's click (public/sw.js) opens its conversation, or the task list, once the app has it; an Android
 * action button also answers the question, if it is still waiting. The home-screen shortcuts (manifest) open the
 * Home the same way, with ?open=.
 */
export function useNoticeLinks(sessions: readonly SessionView[] | undefined, open: (key: string) => void): void {
	const [notice, setNotice] = useState<Notice>();
	useEffect(() => {
		const take = (value: unknown) => {
			const message = value as Notice | undefined;
			if (message?.type === "notice" && typeof message.session === "string") setNotice({ ...message, at: Date.now() });
		};
		const query = new URLSearchParams(location.search), notice = query.get("notice"), shortcut = query.get("open");
		if (notice) { try { take(JSON.parse(notice)); } catch { /* not a notice */ } }
		if (shortcut) take({ type: "notice", session: shortcut });
		if (notice || shortcut) history.replaceState(null, "", location.pathname + location.hash);
		const listen = (event: MessageEvent) => take(event.data);
		navigator.serviceWorker?.addEventListener("message", listen);
		return () => navigator.serviceWorker?.removeEventListener("message", listen);
	}, []);
	useEffect(() => {
		if (!notice?.session) return;
		if (Date.now() - notice.at > WAIT_MS) { setNotice(undefined); return; }
		if (notice.session === "home") { open("home"); setNotice(undefined); return; }
		const target = sessions?.find(session => session.key === notice.session);
		if (!target) return;
		open(target.key); setNotice(undefined);
		const waiting = notice.answer && target.ui?.interactions.find(item => item.id === notice.answer!.interaction);
		if (waiting && target.ui) void api(`/sessions/${target.key}/command`, { id: crypto.randomUUID(), generation: target.ui.generation,
			command: { kind: "answer", id: waiting.id, answer: notice.answer!.answer } }).catch(() => {});
	}, [notice, sessions]);
}

/**
 * Text or a link shared to Desk from another app (Android's share sheet, the manifest's share_target) goes to Home,
 * which adds it to Jordan's tasks, and Home opens.
 */
export function useSharedTask(host: WorkspaceState | undefined, home: string | undefined, open: (key: string) => void): void {
	const [shared] = useState(() => {
		const query = new URLSearchParams(location.search), title = query.get("title") ?? "", text = query.get("text") ?? "", url = query.get("url") ?? "";
		if (!title && !text && !url) return undefined;
		history.replaceState(null, "", location.pathname + location.hash);
		return { title, text, url };
	});
	const added = useRef(false);
	useEffect(() => {
		if (!shared || added.current || !host || !home) return;
		added.current = true;
		// Apps put a shared link in the text as often as in the link.
		const body = [...new Set([shared.title.trim(), shared.text.trim(), shared.url.trim()].filter(Boolean))].join("\n").slice(0, 8000);
		void api("/home/messages", { id: crypto.randomUUID(), text: `Shared to Desk; add it to my tasks:\n${body}`, attachments: [] }, home)
			.then(() => open("home"), () => { added.current = false; });
	}, [shared, host, home]);
}
