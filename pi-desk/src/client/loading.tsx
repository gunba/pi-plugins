/** Something is on its way: a spinner and what is being waited for, so a slow link never looks like a stalled page. */
export function Loading({ label, detail }: { label: string; detail?: string }) {
	return <div className="loading" role="status" aria-live="polite">
		<span className="loading-spinner" aria-hidden="true" />
		<span className="loading-label">{label}</span>
		{detail && <small className="loading-detail">{detail}</small>}
	</div>;
}
