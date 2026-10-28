import { reportUse } from "./connection.ts";

/** A computer counts its user away after 15 minutes without use in any window (host presence.ts); a minute is precise enough. */
const STEP = 60_000;
const ua = navigator.userAgent;
const device = /Android/.test(ua) ? (/Mobile/.test(ua) ? "Android phone" : "Android tablet") : /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad"
	: /Windows/.test(ua) ? "Windows" : /Macintosh/.test(ua) ? "Mac" : /CrOS/.test(ua) ? "Chromebook" : /Linux/.test(ua) ? "Linux" : "a browser";

let lastUsed = 0;
const listeners = new Set<() => void>();
/** When Desk was last used in this window, as trackUse counts use, to the minute. */
export const lastUse = (): number => lastUsed;
/** Calls `listener` when use resumes after a minute or more without it, as when the user comes back. */
export function onUse(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }

/**
 * Tells the computers when Desk was last used in this window: a click, a key, scrolling, touching it, or bringing it to
 * the front. A window merely left open on a screen does not keep its user present.
 */
export function trackUse(): () => void {
	const window_ = crypto.randomUUID();
	let used = lastUsed = document.visibilityState === "visible" && document.hasFocus() ? Date.now() : 0;
	const report = () => { if (used) reportUse(window_, used, device); };
	const use = () => {
		const now = Date.now(); if (now - used < STEP) return;
		used = lastUsed = now; report();
		for (const listener of listeners) listener();
	};
	const moved = () => { if (document.hasFocus()) use(); };
	const shown = () => { if (document.visibilityState === "visible") use(); };
	const events = ["pointerdown", "keydown", "wheel", "touchstart", "focus"] as const;
	for (const name of events) addEventListener(name, use, { passive: true, capture: true });
	addEventListener("pointermove", moved, { passive: true });
	document.addEventListener("visibilitychange", shown);
	// Computers that connected since, or restarted, hear of the last use; nothing is sent when nothing changed.
	const timer = setInterval(report, 15_000);
	report();
	return () => {
		clearInterval(timer);
		for (const name of events) removeEventListener(name, use, { capture: true });
		removeEventListener("pointermove", moved); document.removeEventListener("visibilitychange", shown);
	};
}
