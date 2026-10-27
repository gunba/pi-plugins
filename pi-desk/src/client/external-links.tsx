import { shownUrl } from "../../../pi-show/extensions/links.ts";

export function ExternalLinks({ links = [], text = "" }: { links?: { label: string; url: string }[]; text?: string }) {
	const candidates = [...links, ...(text.match(/https?:\/\/[^\s<>"'`]+/g) ?? []).map(url => ({ label: "", url }))];
	const unique = new Map<string, string>();
	for (const link of candidates) {
		const url = shownUrl(link.url);
		if (url) unique.set(url, link.label || `Open ${new URL(url).host}`);
	}
	return unique.size ? <div className="actions external-links">{[...unique].slice(0, 10).map(([url, label]) =>
		<a key={url} href={url} target="_blank" rel="noopener noreferrer" title={url}>{label} ↗</a>)}</div> : null;
}
