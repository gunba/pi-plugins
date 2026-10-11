/** Classify an HTTP response as a page, a missing page or an automated-client block. */

export type Outcome = "ok" | "not_found" | "blocked" | "http_error" | "network_error";

// Section numbers such as "Sect 404.10" are not error pages; only an error-shaped 404 counts.
const SOFT_404 = /^(?:error\s*)?404\b(?![.\d])|\berror\s*404\b|\bpage not found\b|^not found(?:$|\s*[|:–—-])|^(?:page|content|document|file|resource) (?:not found|unavailable)|\bpage (?:does not|doesn't|no longer) exists?\b|\bpage (?:cannot|could not) be found\b|\bthis page (?:has moved|is no longer available)\b/i;
const CHALLENGE_TITLE = /^(?:just a moment\.*|attention required!?.*|access denied|request blocked|please wait\.*|checking your browser.*|ddos-guard|one more step)$/i;

/** A challenge page in a browser: still waiting on the site's check rather than showing content. */
export function challengeTitle(title: string): boolean { return CHALLENGE_TITLE.test(title.trim()); }
export function softNotFound(title: string): boolean { return !!title.trim() && SOFT_404.test(title.trim()); }

/** Named bot protection when the response carries its signals; undefined for an ordinary response. */
export function protection(status: number, headers: { get(name: string): string | null }, body: string): string | undefined {
	const header = (name: string) => headers.get(name)?.toLowerCase() ?? "";
	const server = header("server"), text = body.slice(0, 64_000).toLowerCase();
	if (header("cf-mitigated") === "challenge") return "Cloudflare challenge";
	if (header("x-vercel-mitigated")) return "Vercel challenge";
	if (header("x-amzn-waf-action") || /awswaf|aws-waf-token/.test(text)) return "AWS WAF challenge";
	if (header("x-datadome") || /captcha-delivery\.com/.test(text)) return "DataDome challenge";
	if (/px-captcha|_pxhd|perimeterx/.test(text)) return "PerimeterX challenge";
	if (header("x-iinfo") || /incapsula incident id|_incapsula_resource/.test(text)) return "Imperva block";
	if (header("x-sucuri-id") || /sucuri website firewall/.test(text)) return "Sucuri block";
	if (status < 400) return;
	if (server.includes("cloudflare") && /just a moment|attention required|cf-chl|challenge-platform|cf-turnstile|cf_chl_opt|cf-error-details/.test(text)) return "Cloudflare challenge";
	if (header("x-cache").includes("error from cloudfront") && /request blocked|request could not be satisfied/.test(text)) return "CloudFront block";
	if (server.includes("akamaighost") || /errors\.edgesuite\.net|reference&#32;&#35;[0-9a-f.]+/.test(text)) return "Akamai block";
	if (/captcha|are you a robot|verify (?:that )?you are (?:a )?human|unusual traffic|automated (?:queries|requests|access)/.test(text)) return "bot check";
	if (status === 429) return "rate limit";
	// A bare 403 to a script is as often a refused client as a forbidden page; only a browser can tell.
	if (status === 403) return "403 to an automated client";
	return;
}

export function classify(status: number, headers: { get(name: string): string | null }, body: string, title: string): { outcome: Outcome; protection?: string; detail?: string } {
	const shield = protection(status, headers, body);
	if (shield) return { outcome: "blocked", protection: shield };
	if (status === 404 || status === 410) return { outcome: "not_found" };
	if (status >= 400) return { outcome: "http_error" };
	if (softNotFound(title)) return { outcome: "not_found", detail: `HTTP ${status}, but the page says "${title.trim().slice(0, 120)}"` };
	return { outcome: "ok" };
}

/** Name a fetch failure: DNS, refused, timeout, reset or an untrusted certificate. */
export function networkDetail(error: unknown): { detail: string; browser: boolean } {
	let cause: unknown = error;
	for (let depth = 0; depth < 4 && cause && typeof cause === "object" && "cause" in cause && (cause as { cause?: unknown }).cause; depth++) cause = (cause as { cause: unknown }).cause;
	const code = String((cause as { code?: unknown })?.code ?? ""), message = String((cause as Error)?.message ?? error);
	if (code === "ENOTFOUND" || code === "EAI_AGAIN") return { detail: `DNS lookup failed (${code})`, browser: false };
	if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER/.test(code))
		return { detail: `TLS certificate not trusted (${code}); a proxy may be intercepting HTTPS`, browser: true };
	if (code === "ECONNRESET" || /handshake|tls|ssl/i.test(message)) return { detail: `TLS or connection reset (${code || message.slice(0, 120)})`, browser: true };
	if (code === "ECONNREFUSED") return { detail: "Connection refused", browser: true };
	if (/TIMEOUT|ETIMEDOUT/.test(code) || /timeout|aborted due to timeout/i.test(message)) return { detail: "Timed out", browser: true };
	return { detail: (code ? `${code}: ` : "") + message.slice(0, 200), browser: true };
}

export function htmlTitle(html: string): string {
	const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
	return match ? decode(match[1]!).replace(/\s+/g, " ").trim() : "";
}

/** Readable text from HTML: scripts, styles and markup removed, block boundaries kept as line breaks. */
export function htmlText(html: string): string {
	return decode(html.replace(/<(script|style|noscript|template|svg)[\s\S]*?<\/\1>/gi, " ").replace(/<!--[\s\S]*?-->/g, " ")
		.replace(/<(?:br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article|\/header|\/footer|\/blockquote)[^>]*>/gi, "\n").replace(/<[^>]+>/g, " "))
		.replace(/[ \t\f\v\u00a0]+/g, " ").replace(/ *\n[\s]*/g, "\n").trim();
}

function decode(text: string): string {
	const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", copy: "©" };
	return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, value: string) => {
		if (value[0] === "#") {
			const code = value[1]?.toLowerCase() === "x" ? parseInt(value.slice(2), 16) : parseInt(value.slice(1), 10);
			return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : entity;
		}
		return named[value.toLowerCase()] ?? entity;
	});
}
