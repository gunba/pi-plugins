import { useEffect, useRef } from "react";
import type { SessionSnapshot } from "../shared/protocol.ts";
import { Icon } from "./icons.tsx";
import { Elapsed } from "./transcript-parts.tsx";

const tokenFormat = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
const REASONS = {
	manual: "You asked Pi to compact this conversation.",
	threshold: "The conversation is close to the model's context limit.",
	overflow: "The last request did not fit in the model's context. Pi will retry it once compacting finishes.",
};

/** Compaction stops the conversation, so it takes over the pane rather than appearing as a status line. */
export function CompactionOverlay({ compacting, context, stopping, stop }: {
	compacting: NonNullable<SessionSnapshot["compacting"]>;
	context?: SessionSnapshot["context"];
	stopping: boolean;
	stop: () => void;
}) {
	const panel = useRef<HTMLDivElement>(null);
	// Keyboard focus would otherwise stay in the covered composer.
	useEffect(() => { if (panel.current?.parentElement?.contains(document.activeElement) === false) panel.current.focus({ preventScroll: true }); }, []);
	const used = context?.tokens, limit = context?.contextWindow;
	return <div className="compaction-overlay">
		<div className="compaction-panel" ref={panel} tabIndex={-1} role="status" aria-live="polite">
			<div className="compaction-mark"><Icon name="layers" /></div>
			<h2>Compacting context</h2>
			<p>{REASONS[compacting.reason]}</p>
			{used != null && limit ? <div className="compaction-meter">
				<div className="compaction-bar"><span style={{ width: `${Math.min(100, used / limit * 100)}%` }} /></div>
				<small>{tokenFormat.format(used)} of {tokenFormat.format(limit)} tokens</small>
			</div> : <div className="compaction-meter"><div className="compaction-bar indeterminate"><span /></div></div>}
			<p className="muted">Pi is replacing earlier messages with a summary so the conversation fits. This can take a few minutes;
				the conversation is unavailable until it finishes.</p>
			<div className="compaction-actions"><span className="compaction-elapsed"><span className="pulse-dot" /><Elapsed started={compacting.started} /></span>
				<button type="button" disabled={stopping} onClick={stop}>{stopping ? "Stopping…" : "Stop compacting"}</button></div>
		</div>
	</div>;
}
