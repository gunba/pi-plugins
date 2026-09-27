export function ExternalLinks({ links = [], text = "" }: { links?: { label: string; url: string }[]; text?: string }) {
	const candidates = [...links, ...(text.match(/https?:\/\/[^\s<>"'`]+/g) ?? []).map(url => ({ label: "", url }))];
	const unique = new Map<string, string>();
	for (const link of candidates) {
		try {
			const url = new URL(link.url);
			if ((url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password) {
				unique.set(url.href, link.label || `Open ${url.host}`);
			}
		} catch { /* Only navigable web links receive a control. */ }
	}
	return unique.size ? <div className="actions external-links">{[...unique].slice(0, 10).map(([url, label]) =>
		<a key={url} href={url} target="_blank" rel="noopener noreferrer" title={url}>{label} ↗</a>)}</div> : null;
}
