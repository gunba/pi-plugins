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
 * task list or the Dot the same way, with ?open=.
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
		if (notice.session === "quests" || notice.session === "dot") { open(notice.session); setNotice(undefined); return; }
		const target = sessions?.find(session => session.key === notice.session);
		if (!target) return;
		open(target.key); setNotice(undefined);
		const waiting = notice.answer && target.ui?.interactions.find(item => item.id === notice.answer!.interaction);
		if (waiting && target.ui) void api(`/sessions/${target.key}/command`, { id: crypto.randomUUID(), generation: target.ui.generation,
			command: { kind: "answer", id: waiting.id, answer: notice.answer!.answer } }).catch(() => {});
	}, [notice, sessions]);
}

/**
 * Text or a link shared to Desk from another app (Android's share sheet, the manifest's share_target) becomes a task
 * on the computer that keeps your tasks, and the task list opens to it.
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
		if (!shared || added.current || !host) return;
		const logs: (string | undefined)[] = host.computers ? host.computers.filter(computer => computer.quests && computer.connected).map(computer => computer.id)
			: host.quests ? [undefined] : [];
		if (!logs.length) return;
		const target = logs.includes(home) ? home : logs[0];
		added.current = true;
		// Apps put a shared link in the text as often as in the link; the first line names the task.
		const body = [...new Set([shared.text.trim(), shared.url.trim()].filter(Boolean))].join("\n");
		const title = (shared.title.trim() || body.split("\n")[0] || "Shared").slice(0, 200), notes = body === title ? "" : body.slice(0, 4000);
		void api("/quests", { command: { action: "add", title, kind: "main", ...(notes ? { notes } : {}) } }, target)
			.then(() => open("quests"), () => { added.current = false; });
	}, [shared, host, home]);
}
