import type { UiConversation } from "../../../pi-ui/index.ts";
import type { SessionView, ViewSnapshot } from "./protocol.ts";

/** Agents a conversation started that are still working or have tasks queued; it wakes when they report. */
export function workingAgents(views: readonly ViewSnapshot[]): ViewSnapshot[] {
	return views.filter(view => {
		if (view.kind !== "conversation") return false;
		const data = view.data as UiConversation;
		return !!data.active || Number(data.fields?.find(field => field.label === "Queued tasks")?.value ?? 0) > 0;
	});
}

/**
 * Its turn has ended and nothing will wake it again: no question waits, no watch or scheduled wake is set and no agent
 * it started is working. Only the user can move it on. Conversations an agent started report to that agent instead.
 */
export function waitsForUser(view: SessionView): boolean {
	const activity = view.snapshot?.activity;
	return view.state === "ready" && !view.createdBy && (activity === "idle" || activity === "error")
		&& !view.ui?.interactions.some(item => !item.settings) && !view.watching && !view.wakes && !workingAgents(view.ui?.views ?? []).length;
}

/**
 * Marks when a conversation that has worked comes to wait for the user, and clears the mark when it works again. The
 * mark outlasts closing, so a conversation put to sleep still shows it finished. `settling` says a turn ran since it was
 * last marked (the host also sets it when a turn ends), so a conversation merely resumed or reconnected is not marked.
 */
export function settle(managed: { view: SessionView; settling?: boolean }, now = Date.now()): void {
	const { view } = managed;
	if (view.state !== "ready") return;
	if (view.snapshot?.activity === "running" || view.snapshot?.activity === "waiting") {
		managed.settling = true;
		if (view.finished) managed.view = { ...view, finished: undefined };
	} else if (managed.settling && waitsForUser(view)) {
		managed.settling = false;
		managed.view = { ...view, finished: now };
	} else if (managed.settling && view.finished) {
		// A turn too quick for a running snapshot ended waiting on a watch, a wake or an agent: it is not finished.
		managed.view = { ...view, finished: undefined };
	}
}

/** It finished after anyone last looked at it, on any device. */
export const unseen = (view: Pick<SessionView, "finished" | "seen">): boolean => !!view.finished && (view.seen ?? 0) < view.finished;
