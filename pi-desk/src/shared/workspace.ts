import type { SessionView } from "./protocol.ts";

/** Workspace membership survives interruption and a Close that keeps it, but not an explicit Close and remove. */
export function isOpenSession(session: SessionView): boolean {
	return session.state !== "closed" || session.interrupted === true || session.kept === true;
}
