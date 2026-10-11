import { useState } from "react";
import type { WorkspaceSession } from "./workspace.ts";

type Host = { name: string; release?: { version: string } };
import { api } from "./connection.ts";
import { Icon } from "./icons.tsx";

/** A running conversation keeps the code it started with; this is the version it runs when that differs from its computer's. */
export function staleVersion(session: WorkspaceSession, computer?: Host): { running: string; current: string } | undefined {
	const current = computer?.release?.version;
	if (!current || session.state !== "ready") return;
	const running = session.workerRuntime?.version;
	return running === current ? undefined : { running: running ?? "an older version", current };
}

export function VersionTag({ session, computer }: { session: WorkspaceSession; computer?: Host }) {
	const stale = staleVersion(session, computer);
	return stale ? <span className="session-version" title={`Running Desk ${stale.running}; this computer has ${stale.current}. Restart it to use the new version. History is kept.`}>
		{stale.running.startsWith("an ") ? "old" : stale.running}</span> : null;
}

export function VersionBanner({ session, computer, busy, report }: {
	session: WorkspaceSession; computer?: Host; busy: boolean; report: (error: string) => void;
}) {
	const [restarting, setRestarting] = useState(false);
	const stale = staleVersion(session, computer);
	if (!stale) return null;
	return <div className="version-banner" role="status">
		<Icon name="refresh" />
		<span>This conversation runs Desk {stale.running}; {computer?.name ?? "this computer"} has {stale.current}. It keeps its tools and fixes until restarted. History is kept.</span>
		<button disabled={busy || restarting} title={busy ? "Restart when the conversation is idle." : undefined} onClick={() => {
			setRestarting(true);
			void api(`/sessions/${session.key}/restart`, { replace: true }, session.computer)
				.catch(error => report(error instanceof Error ? error.message : String(error))).finally(() => setRestarting(false));
		}}>{restarting ? "Restarting…" : `Restart on ${stale.current}`}</button>
	</div>;
}
