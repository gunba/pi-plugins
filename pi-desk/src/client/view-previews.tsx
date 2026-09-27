import type { ViewSnapshot } from "../shared/protocol.ts";

export function ViewPreviews({ views, open }: { views: readonly ViewSnapshot[]; open: (id: string) => void }) {
	const previews = views.filter(view => view.preview);
	if (!previews.length) return null;
	return <div className="view-previews">{previews.map(view => <button className="view-preview" key={view.id} type="button"
		onClick={() => open(view.id)} title={view.preview!.primary}>
		<strong>{view.preview!.label}</strong><span><b>{view.preview!.primary}</b>
			{view.preview!.secondary && <small>{view.preview!.secondary}</small>}</span><span aria-hidden="true">›</span>
	</button>)}</div>;
}
