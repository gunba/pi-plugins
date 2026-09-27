import type { SessionSnapshot } from "../shared/protocol.ts";
export function NativeQueue({ queue }: { queue: SessionSnapshot["queue"] }) {
	if (!queue.steering.count && !queue.followUp.count) return null;
	return <details className="native-queue">
		<summary>In Pi: {queue.steering.count} steering · {queue.followUp.count} follow-up</summary>
		{([["Steering", queue.steering], ["Follow-up", queue.followUp]] as const).filter(([, group]) => group.count).map(([title, group]) => <div key={title}>
			<strong>{title}</strong><ol>{group.previews.map((text, index) => <li key={index}>{text}</li>)}</ol>
			{group.count > group.previews.length && <small>Showing the first {group.previews.length} of {group.count}.</small>}
		</div>)}
	</details>;
}
