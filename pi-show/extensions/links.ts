/** Normalize a web link without resolving or fetching it; credentials and non-web schemes are not navigable. */
export function shownUrl(value: string): string | undefined {
	try {
		const url = new URL(value);
		if ((url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password) return url.href;
	} catch { /* Malformed links remain text. */ }
}
