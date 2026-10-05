import type { SessionSnapshot, SessionView } from "../shared/protocol.ts";

/** Presentation data has one owner in a display session, including during incremental UI refreshes. */
export function sessionDisplay(snapshot: SessionSnapshot): Pick<SessionView, "snapshot" | "ui"> {
	const { ui, ...details } = snapshot;
	return { snapshot: details, ui };
}
