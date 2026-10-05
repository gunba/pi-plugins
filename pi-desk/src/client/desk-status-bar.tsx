import { useEffect, useSyncExternalStore } from "react";
import { deskStatus, dismissDeskStatus, subscribeDeskStatus } from "./desk-status.ts";
import { Icon } from "./icons.tsx";

export function DeskStatusBar() {
	const status = useSyncExternalStore(subscribeDeskStatus, deskStatus, () => undefined);
	useEffect(() => {
		if (!status) return;
		const timer = setTimeout(() => dismissDeskStatus(status.id), Math.max(0, status.expires - Date.now()));
		return () => clearTimeout(timer);
	}, [status]);
	return status ? <aside className="desk-status-bar" role="status" aria-live="polite" aria-label="Desk status">
		<Icon name="info" /><div><span>{status.text}</span>
			{status.text !== status.details && <details><summary>Details</summary><p>{status.details}</p></details>}
		</div><button className="icon-button" aria-label="Dismiss Desk status" onClick={() => dismissDeskStatus(status.id)}><Icon name="close" /></button>
	</aside> : null;
}
