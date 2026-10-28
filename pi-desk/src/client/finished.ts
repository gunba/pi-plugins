import { useEffect, useRef } from "react";
import { api } from "./connection.ts";
import { lastUse, onUse } from "./presence.ts";
import { unseen } from "../shared/attention.ts";
import type { SessionView } from "../shared/protocol.ts";

/** Use this recent, with the conversation open and on screen, counts as looking at it. */
const LOOKING = 2 * 60_000;

/**
 * Tells a conversation's computer when the user looks at it after it finished: it is open and on screen, and Desk was
 * used in the last two minutes or is used again. A window left open while the user is away does not clear the mark.
 */
export function useSeen(session: SessionView | undefined): void {
	const told = useRef("");
	const key = session?.key, finished = session && unseen(session) ? session.finished : undefined;
	useEffect(() => {
		if (!key || !finished) return;
		const look = () => {
			const mark = `${key}:${finished}`;
			if (told.current === mark || document.visibilityState !== "visible" || Date.now() - lastUse() > LOOKING) return;
			told.current = mark;
			void api(`/sessions/${key}/seen`, {}).catch(() => { told.current = ""; });
		};
		look();
		const stop = onUse(look);
		document.addEventListener("visibilitychange", look);
		return () => { stop(); document.removeEventListener("visibilitychange", look); };
	}, [key, finished]);
}

/** How many conversations finished since anyone looked, on the installed app's icon where the platform shows badges. */
export function useFinishedBadge(sessions: readonly SessionView[] | undefined): void {
	// Closed by the user, it is no longer listed as finished; put to sleep by Desk (kept), it still is.
	const count = sessions?.filter(view => unseen(view) && (view.state !== "closed" || view.kept)).length ?? 0;
	useEffect(() => {
		if (!("setAppBadge" in navigator)) return;
		void (count ? navigator.setAppBadge(count) : navigator.clearAppBadge()).catch(() => {});
	}, [count]);
}
