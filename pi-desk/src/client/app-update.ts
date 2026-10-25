import { useSyncExternalStore } from "react";

/**
 * A tab left open keeps running the app it loaded, so new versions never reached it. The service worker is asked now and
 * then whether a newer page is cached (public/sw.js); once one is, the app reloads after it has been out of sight for a
 * while, or the user reloads it from the notice.
 */
const CHECK_MS = 60 * 60_000, VISIBLE_CHECK_MS = 10 * 60_000, HIDDEN_RELOAD_MS = 5 * 60_000;
let ready = false, lastCheck = 0, hiddenTimer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

/** The app's own script, which every release renames. */
function ownScript(): string | undefined {
	const script = document.querySelector<HTMLScriptElement>("script[type=module][src*='/assets/']");
	return script ? new URL(script.src).pathname : undefined;
}

async function check(): Promise<void> {
	lastCheck = Date.now();
	const own = ownScript(), registration = await navigator.serviceWorker?.getRegistration().catch(() => undefined);
	if (!own || !registration || ready) return;
	await registration.update().catch(() => {});
	const worker = registration.active;
	if (!worker) return;
	const assets = await new Promise<string[]>(resolve => {
		const channel = new MessageChannel(), timer = setTimeout(() => resolve([]), 60_000);
		channel.port1.onmessage = event => { clearTimeout(timer); resolve(Array.isArray(event.data?.assets) ? event.data.assets : []); };
		worker.postMessage({ type: "check" }, [channel.port2]);
	});
	if (!assets.length || assets.includes(own)) return;
	ready = true;
	for (const listener of listeners) listener();
	if (document.visibilityState === "hidden") schedule();
}
function schedule(): void {
	clearTimeout(hiddenTimer);
	hiddenTimer = setTimeout(() => { if (document.visibilityState === "hidden") location.reload(); }, HIDDEN_RELOAD_MS);
}

export function startUpdateChecks(): void {
	if (!("serviceWorker" in navigator)) return;
	setTimeout(() => void check(), 30_000);
	setInterval(() => { if (document.visibilityState === "visible") void check(); }, CHECK_MS);
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState === "visible") {
			clearTimeout(hiddenTimer);
			if (Date.now() - lastCheck > VISIBLE_CHECK_MS) void check();
		} else if (ready) schedule();
	});
}

/** Whether a newer version of the app is ready to load. */
export function useAppUpdate(): boolean {
	return useSyncExternalStore(listener => { listeners.add(listener); return () => listeners.delete(listener); }, () => ready);
}
