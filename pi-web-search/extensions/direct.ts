/**
 * Reads a page with a plain request from this computer: its own network, address and country, without
 * running JavaScript. `web_fetch` uses it for pages the search service could not read, which include
 * sites that refuse crawlers' data-centre addresses, and for local network addresses the service cannot
 * reach.
 */
import { isIP } from "node:net";

const TIMEOUT_MS = 30_000;
const MAX_BYTES = 10_000_000;
const USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

export type DirectPage = { url: string; title?: string; text: string };

/** Hosts only this computer can reach: loopback, private and link-local ranges, Tailscale, and names without a dot. */
export function isLocalUrl(url: string): boolean {
	let host: string;
	try { host = new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase(); } catch { return false; }
	if (!isIP(host)) return !host.includes(".") || host.endsWith(".local") || host.endsWith(".localhost") || host.endsWith(".internal");
	if (isIP(host) === 6) return host === "::1" || /^f[cd]|^fe[89ab]/.test(host);
	const [a, b] = host.split(".").map(Number);
	return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
}

/** The page's text, or why it could not be read. */
export async function readDirect(url: string, signal: AbortSignal): Promise<DirectPage | string> {
	let response: Response;
	try {
		response = await fetch(url, { redirect: "follow", signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]), headers: {
			"user-agent": USER_AGENT,
			accept: "text/html,application/xhtml+xml,text/plain,application/json,application/xml;q=0.9,*/*;q=0.5",
			"accept-language": `${Intl.DateTimeFormat().resolvedOptions().locale},en;q=0.8`,
		} });
	} catch (error) {
		if (signal.aborted) throw error;
		return (error as Error).name === "TimeoutError" ? "timed out" : `could not connect (${(error as { cause?: { code?: string } }).cause?.code ?? (error as Error).message})`;
	}
	const type = (response.headers.get("content-type") ?? "").toLowerCase();
	if (Number(response.headers.get("content-length")) > MAX_BYTES) return `too large (${response.headers.get("content-length")} bytes)`;
	const bytes = new Uint8Array(await response.arrayBuffer());
	if (bytes.length > MAX_BYTES) return `too large (${bytes.length} bytes)`;
	const body = decode(bytes, type);
	if (!response.ok) {
		const check = response.headers.has("cf-mitigated") || /<title>\s*(Just a moment|Attention Required)/i.test(body);
		return check ? `the site requires a browser to pass its bot check (HTTP ${response.status})` : `HTTP ${response.status}`;
	}
	const finalUrl = response.url || url;
	if (/html|xml\+xhtml/.test(type) || (!type && /^\s*<(!doctype html|html)/i.test(body))) return { url: finalUrl, ...htmlText(body) };
	if (/^text\/|json|xml/.test(type)) return { url: finalUrl, text: body };
	return `${type.split(";")[0] || "this file type"} is not readable as text here`;
}

function decode(bytes: Uint8Array, type: string): string {
	const sniffed = /charset=["']?([\w-]+)/i.exec(type)?.[1] ?? /<meta[^>]+charset=["']?([\w-]+)/i.exec(new TextDecoder("latin1").decode(bytes.subarray(0, 4096)))?.[1];
	try { return new TextDecoder(sniffed ?? "utf-8").decode(bytes); } catch { return new TextDecoder().decode(bytes); }
}

const ENTITIES: Record<string, string> = { nbsp: " ", lt: "<", gt: ">", quot: "\"", apos: "'", ndash: "–", mdash: "—", lsquo: "‘", rsquo: "’",
	ldquo: "“", rdquo: "”", hellip: "…", copy: "©", reg: "®", trade: "™", sect: "§", para: "¶", middot: "·", bull: "•", laquo: "«", raquo: "»",
	times: "×", deg: "°", shy: "", zwj: "", zwnj: "", amp: "&" };

function entities(text: string): string {
	return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
		if (name[0] !== "#") return ENTITIES[name.toLowerCase()] ?? whole;
		const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : Number(name.slice(1));
		return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
	});
}

/** Readable text of the page's main content, with headings and list items marked as in Markdown. */
export function htmlText(html: string): { title?: string; text: string } {
	const title = entities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "").replace(/\s+/g, " ").trim() || undefined;
	let body = html.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/<(script|style|noscript|svg|template|iframe|head|nav|header|footer|aside|form|button|select|dialog)\b[\s\S]*?<\/\1\s*>/gi, "");
	body = /<main\b[^>]*>([\s\S]*)<\/main>/i.exec(body)?.[1] ?? /<article\b[^>]*>([\s\S]*)<\/article>/i.exec(body)?.[1] ?? /<body\b[^>]*>([\s\S]*)<\/body>/i.exec(body)?.[1] ?? body;
	const text = entities(body
		.replace(/<h([1-6])\b[^>]*>/gi, (_tag, level: string) => `\n\n${"#".repeat(Number(level))} `)
		.replace(/<\/h[1-6]\s*>/gi, "\n\n")
		.replace(/<li\b[^>]*>/gi, "\n- ")
		.replace(/<t[dh]\b[^>]*>/gi, " | ")
		.replace(/<\/?(p|div|section|article|table|thead|tbody|tr|ul|ol|dl|dt|dd|blockquote|pre|br|hr|figure|figcaption|address|details|summary)\b[^>]*>/gi, "\n")
		.replace(/<[^>]+>/g, ""));
	return { title, text: text.split("\n").map(line => line.replace(/[ \t\u00a0]+/g, " ").trim()).join("\n").replace(/\n{3,}/g, "\n\n").trim() };
}
