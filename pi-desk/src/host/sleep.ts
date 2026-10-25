import { statSync } from "node:fs";
import { uptime } from "node:os";
import type { SessionView } from "../shared/protocol.ts";
import type { UiDetails } from "../../../pi-ui/index.ts";

/**
 * Conversations that sleep: closed and kept in the sidebar with no process running, reopened when one of their watches
 * has news, and closed again once the turn that news started is done. The watches' commands run detached and write
 * the files their views name (UiView.wakeFiles); a change to one of those files is the news.
 */

/** A file's size and modification time, or "missing". */
function stamp(path: string): string {
	try { const stat = statSync(path); return `${stat.size}:${Math.round(stat.mtimeMs)}`; } catch { return "missing"; }
}
/** When the computer started, to the second or so. */
const boot = () => Date.now() - uptime() * 1000;

/** What a conversation closing now, kept, has to be woken by; undefined when its views name no files. */
export function asleep(ui: SessionView["ui"]): SessionView["asleep"] {
	const files = [...new Set(ui?.views.flatMap(view => view.wakeFiles ?? []) ?? [])];
	return files.length ? { files: files.map(path => ({ path, stamp: stamp(path) })), boot: boot() } : undefined;
}

/** What a conversation closing now, kept, waits on, for the user to read while it sleeps: the items of the views that wake it. */
export function waiting(ui: SessionView["ui"]): SessionView["waiting"] {
	const items = (ui?.views ?? []).filter(view => view.wakes || view.watching || view.wakeFiles?.length)
		.flatMap(view => (view.data as UiDetails | null)?.items ?? []).slice(0, 8)
		.map(item => ({ title: item.title.slice(0, 200), ...(item.subtitle ? { detail: item.subtitle.slice(0, 400) } : {}) }));
	return items.length ? items : undefined;
}

/** A sleeping conversation has news when a file changed, or when the computer restarted, which stopped its commands. */
export function hasNews(record: NonNullable<SessionView["asleep"]>): boolean {
	return Math.abs(boot() - record.boot) > 120_000 || record.files.some(file => stamp(file.path) !== file.stamp);
}

/** How long a conversation that may sleep stays open once idle, so its user can carry on if they are there. */
export const SLEEP_AFTER_MS = 120_000;

/**
 * Whether a running conversation is at rest: idle, with nothing it waits on from the user (questions, messages not yet
 * delivered, an operation) and no agents of its own working.
 */
export function atRest(view: SessionView, pendingInputs: number): boolean {
	return view.state === "ready" && view.snapshot?.activity === "idle" && !view.reconnecting && !view.updating && !pendingInputs
		&& !view.controls?.some(control => control.state === "running")
		&& !view.ui?.interactions.some(item => !item.settings)
		&& !view.ui?.views.some(item => item.kind === "conversation" && (item.data as { active?: boolean } | null)?.active);
}
