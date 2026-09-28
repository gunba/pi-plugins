import type { SessionView } from "./protocol.ts";

/** Workspace membership survives interruption, but not an explicit Close. */
export function isOpenSession(session: SessionView): boolean {
	return session.state !== "closed" || session.interrupted === true;
}
