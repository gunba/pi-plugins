import { readFileSync } from "node:fs";
import { join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { challengeTitle, classify, htmlText, htmlTitle, networkDetail, softNotFound, type Outcome } from "./page-check.ts";

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";
const BODY_LIMIT = 4 * 1024 * 1024;
const BROWSER_WAIT_MS = 30_000;

export interface PageResult {
	url: string; outcome: Outcome; via: "http" | "browser"; status?: number; finalUrl?: string; title?: string;
	protection?: string; detail?: string; text?: string; truncated?: boolean;
	/** The script request's result when the browser decided the outcome. */
	script?: { status?: number; outcome: Outcome; protection?: string; detail?: string };
}

async function readBody(response: Response, signal: AbortSignal): Promise<string> {
	if (!response.body) return "";
	const reader = response.body.getReader(), chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (size < BODY_LIMIT) {
			signal.throwIfAborted();
			const { done, value } = await reader.read();
			if (done) break;
			chunks.push(value); size += value.byteLength;
		}
	} finally { void reader.cancel().catch(() => {}); }
	const charset = /charset=([\w-]+)/i.exec(response.headers.get("content-type") ?? "")?.[1];
	try { return new TextDecoder(charset ?? "utf-8").decode(Buffer.concat(chunks)); }
	catch { return new TextDecoder().decode(Buffer.concat(chunks)); }
}

export async function scriptFetch(url: string, signal: AbortSignal): Promise<PageResult & { retry: boolean; body?: string }> {
	const timeout = AbortSignal.any([signal, AbortSignal.timeout(20_000)]);
	try {
		const response = await fetch(url, { redirect: "follow", signal: timeout, headers: {
			"User-Agent": USER_AGENT, "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", "Accept-Language": "en-AU,en;q=0.9",
		} });
		const type = response.headers.get("content-type") ?? "";
		const textual = !type || /text\/|html|xml|json|javascript/.test(type);
		const body = textual ? await readBody(response, timeout) : (void response.body?.cancel().catch(() => {}), "");
		const title = /html/.test(type) || /^\s*</.test(body) ? htmlTitle(body) : "";
		const verdict = classify(response.status, response.headers, body, title);
		return { url, via: "http", status: response.status, finalUrl: response.url !== url ? response.url : undefined, title: title || undefined, ...verdict,
			...(textual ? {} : { detail: [verdict.detail, `${type || "binary"} content, ${response.headers.get("content-length") ?? "unknown"} bytes; not read`].filter(Boolean).join("; ") }),
			body: textual ? body : undefined, retry: verdict.outcome === "blocked" };
	} catch (error) {
		signal.throwIfAborted();
		const failure = networkDetail(error);
		return { url, via: "http", outcome: "network_error", detail: failure.detail, retry: failure.browser };
	}
}

function chromeEndpoint(): string {
	try {
		const config = JSON.parse(readFileSync(join(getAgentDir(), "pi-chrome-devtools.json"), "utf8")) as { browser?: { endpoint?: unknown } };
		if (typeof config.browser?.endpoint === "string" && /^https?:\/\//.test(config.browser.endpoint)) return config.browser.endpoint.replace(/\/+$/, "");
	} catch { /* Use Chrome's conventional debugging port. */ }
	return "http://127.0.0.1:9222";
}

type Listener = (method: string, params: Record<string, unknown>, session?: string) => void;
/** Minimal CDP connection to the browser target, using Node's built-in WebSocket. */
async function connect(endpoint: string, signal: AbortSignal) {
	const version = await (await fetch(`${endpoint}/json/version`, { signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]) })).json() as { webSocketDebuggerUrl?: string };
	if (!version.webSocketDebuggerUrl) throw Error("Chrome did not report a debugging WebSocket.");
	const socket = new WebSocket(version.webSocketDebuggerUrl);
	await new Promise<void>((resolve, reject) => {
		socket.addEventListener("open", () => resolve(), { once: true });
		socket.addEventListener("error", () => reject(Error("Could not connect to Chrome's debugging WebSocket.")), { once: true });
	});
	let id = 0;
	const pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>(), listeners = new Set<Listener>();
	socket.addEventListener("message", event => {
		const message = JSON.parse(String(event.data)) as { id?: number; result?: Record<string, unknown>; error?: { message: string }; method?: string; params?: Record<string, unknown>; sessionId?: string };
		if (message.id !== undefined) {
			const waiter = pending.get(message.id); pending.delete(message.id);
			if (message.error) waiter?.reject(Error(message.error.message)); else waiter?.resolve(message.result ?? {});
		} else if (message.method) for (const listener of listeners) listener(message.method, message.params ?? {}, message.sessionId);
	});
	socket.addEventListener("close", () => { for (const waiter of pending.values()) waiter.reject(Error("Chrome closed the debugging connection.")); pending.clear(); });
	return {
		send: (method: string, params: Record<string, unknown> = {}, sessionId?: string) => new Promise<Record<string, unknown>>((resolve, reject) => {
			const next = ++id; pending.set(next, { resolve, reject });
			socket.send(JSON.stringify({ id: next, method, params, ...(sessionId ? { sessionId } : {}) }));
		}),
		listen: (listener: Listener) => { listeners.add(listener); },
		close: () => socket.close(),
	};
}

const delay = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
	const timer = setTimeout(resolve, ms);
	signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
});

/** Load a page in a background tab of the user's Chrome, waiting out challenge pages that reload themselves. */
export async function browserLoad(url: string, maxChars: number, signal: AbortSignal): Promise<Omit<PageResult, "url" | "script">> {
	const endpoint = chromeEndpoint();
	let cdp: Awaited<ReturnType<typeof connect>>;
	try { cdp = await connect(endpoint, signal); }
	catch { throw Error(`Chrome is not reachable at ${endpoint}. Start it with remote debugging (see the browse skill) to check pages a script cannot load.`); }
	let target: string | undefined;
	try {
		target = String((await cdp.send("Target.createTarget", { url: "about:blank", background: true })).targetId);
		const session = String((await cdp.send("Target.attachToTarget", { targetId: target, flatten: true })).sessionId);
		const frame = String(((await cdp.send("Page.getFrameTree", {}, session)).frameTree as { frame: { id: string } }).frame.id);
		let status: number | undefined, loaded = false;
		cdp.listen((method, params, from) => {
			if (from !== session) return;
			if (method === "Network.responseReceived" && params.type === "Document" && params.frameId === frame) status = Number((params.response as { status?: number }).status);
			if (method === "Page.loadEventFired") loaded = true;
			// A challenge that passes navigates again; wait for that document too.
			if (method === "Page.frameStartedLoading" && params.frameId === frame) loaded = false;
		});
		await cdp.send("Network.enable", {}, session); await cdp.send("Page.enable", {}, session);
		const navigation = await cdp.send("Page.navigate", { url }, session);
		if (navigation.errorText) {
			const detail = String(navigation.errorText);
			return { outcome: /NAME_NOT_RESOLVED|ADDRESS_UNREACHABLE|INTERNET_DISCONNECTED|CONNECTION|SSL|CERT|TIMED_OUT/.test(detail) ? "network_error" : "http_error", via: "browser", detail };
		}
		const deadline = Date.now() + BROWSER_WAIT_MS;
		let page: { title: string; url: string; text: string; challenge: boolean } | undefined;
		while (Date.now() < deadline) {
			await delay(loaded ? 600 : 400, signal);
			// Read once loaded, or after half the wait for pages whose load event never fires.
			const settled = loaded || Date.now() > deadline - BROWSER_WAIT_MS / 2;
			if (!settled) continue;
			try {
				// A challenge replaces the document mid-read; that throws and the loop reads again.
				const result = await cdp.send("Runtime.evaluate", { returnByValue: true, expression: `({ title: document.title, url: location.href,
					text: (document.body?.innerText ?? "").slice(0, ${maxChars + 1}),
					challenge: !!document.querySelector('#challenge-form, #challenge-stage, #cf-challenge-running, .cf-turnstile, iframe[src*="challenges.cloudflare.com"], #px-captcha, iframe[src*="captcha-delivery.com"]') })` }, session);
				page = (result.result as { value?: typeof page }).value;
			} catch { page = undefined; continue; }
			if (page && !page.challenge && !challengeTitle(page.title)) break;
		}
		if (!page) return { outcome: "network_error", via: "browser", status, detail: "The page did not finish loading in Chrome." };
		const finalUrl = page.url !== url ? page.url : undefined, title = page.title.trim() || undefined;
		const text = page.text.slice(0, maxChars), truncated = page.text.length > maxChars;
		if (page.challenge || challengeTitle(page.title))
			return { outcome: "blocked", via: "browser", status, finalUrl, title, protection: "challenge still shown in Chrome",
				detail: "The site's check did not clear within 30 seconds. Open the URL in Chrome to complete it, then try again." };
		if (status === 404 || status === 410) return { outcome: "not_found", via: "browser", status, finalUrl, title, text, truncated };
		if (title && softNotFound(title)) return { outcome: "not_found", via: "browser", status, finalUrl, title, text, truncated,
			detail: `HTTP ${status ?? "status unknown"}, but the page says "${title.slice(0, 120)}"` };
		if (status !== undefined && status >= 400) return { outcome: "http_error", via: "browser", status, finalUrl, title, text, truncated };
		return { outcome: "ok", via: "browser", status, finalUrl, title, text, truncated };
	} finally {
		if (target) await cdp.send("Target.closeTarget", { targetId: target }).catch(() => {});
		cdp.close();
	}
}

type Direct = Awaited<ReturnType<typeof scriptFetch>>;
/** Keep the direct result unless it was blocked or could not connect; then let Chrome decide. */
async function settle(url: string, direct: Direct | undefined, includeText: boolean, maxChars: number, browser: "auto" | "never" | "always", signal: AbortSignal): Promise<PageResult> {
	if (direct && (browser === "never" || !direct.retry)) {
		const { retry: _retry, body, ...result } = direct;
		if (!includeText || body === undefined || result.outcome === "network_error") return result;
		const text = /^\s*</.test(body) ? htmlText(body) : body;
		return { ...result, text: text.slice(0, maxChars), truncated: text.length > maxChars };
	}
	const script = direct && { status: direct.status, outcome: direct.outcome, protection: direct.protection, detail: direct.detail };
	try {
		const page = await browserLoad(url, includeText ? maxChars : 2000, signal);
		return { url, ...page, ...(includeText ? {} : { text: undefined, truncated: undefined }), ...(script ? { script } : {}) };
	} catch (error) {
		signal.throwIfAborted();
		const reason = error instanceof Error ? error.message : String(error);
		if (!direct) return { url, via: "browser", outcome: "network_error", detail: reason };
		const { retry: _retry, body: _body, ...result } = direct;
		return { ...result, detail: [result.detail, `Not verified in a browser: ${reason}`].filter(Boolean).join(". ") };
	}
}

async function pool<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (next < items.length) { const index = next++; results[index] = await work(items[index]!); }
	}));
	return results;
}

const MEANING: Record<Outcome, string> = {
	ok: "page loaded", not_found: "missing page", blocked: "refused an automated client; not evidence the page is missing",
	http_error: "server error", network_error: "could not connect",
};
function describe(result: PageResult): string {
	const facts = [result.status !== undefined && `HTTP ${result.status}`, `via ${result.via}`, result.protection, result.finalUrl && `final URL ${result.finalUrl}`,
		result.script && `script saw ${result.script.status ? `HTTP ${result.script.status} ` : ""}${result.script.protection ?? result.script.detail ?? result.script.outcome}`].filter(Boolean);
	return `${result.url}\n  ${result.outcome}: ${MEANING[result.outcome]} (${facts.join("; ")})${result.title ? `\n  Title: ${result.title}` : ""}${result.detail ? `\n  ${result.detail}` : ""}`;
}

export default function webFetchExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "web_fetch", label: "Fetch page",
		description: "Read or check web pages. Each URL is fetched directly; when a site refuses automated clients (Cloudflare, Akamai, CloudFront and similar bot protection) or the connection fails, it is loaded in a background tab of the user's Chrome instead. Outcomes: ok, not_found (including pages that return 200 but say \"Page not found\"), blocked, http_error or network_error.",
		promptSnippet: "Read or check web pages, falling back to Chrome when a site refuses automated clients",
		promptGuidelines: [
			"Use web_fetch rather than curl, wget or scripts to read or check URLs: those report bot protection, rate limits and TLS failures as ordinary errors.",
			"A blocked outcome means the site refused an automated client, not that the page is missing or broken. Do not report it as a broken link or as missing evidence.",
		],
		parameters: Type.Object({
			urls: Type.Array(Type.String({ minLength: 1, maxLength: 4000 }), { minItems: 1, maxItems: 50, description: "http(s) URLs to read or check." }),
			text: Type.Optional(Type.Boolean({ description: "Include readable page text. Defaults to true for one URL and false for several." })),
			max_chars: Type.Optional(Type.Integer({ minimum: 500, maximum: 60_000, description: "Page text limit per URL. Default 12000." })),
			browser: Type.Optional(StringEnum(["auto", "never", "always"] as const, {
				description: "auto (default) uses Chrome only when the direct request is blocked or cannot connect." })),
		}),
		async execute(_id, params, signal) {
			const abort = signal ?? new AbortController().signal;
			const urls = params.urls.map(url => url.trim());
			const bad = urls.find(url => { try { return !/^https?:$/.test(new URL(url).protocol); } catch { return true; } });
			if (bad) throw Error(`Not an http(s) URL: ${bad}`);
			const includeText = params.text ?? urls.length === 1, maxChars = params.max_chars ?? 12_000;
			// Direct requests run in parallel; browser fallbacks are few at a time to keep Chrome responsive.
			const browser = params.browser ?? "auto";
			const direct = browser === "always" ? undefined : await pool(urls, 8, url => scriptFetch(url, abort));
			const results = await pool(urls.map((url, index) => ({ url, index })), 3,
				({ url, index }) => settle(url, direct?.[index], includeText, maxChars, browser, abort));
			const text = results.map(result => describe(result) + (result.text ? `\n\n${result.text}${result.truncated ? "\n[…truncated]" : ""}\n` : "")).join("\n");
			const counts = results.reduce<Record<string, number>>((all, result) => ({ ...all, [result.outcome]: (all[result.outcome] ?? 0) + 1 }), {});
			return { content: [{ type: "text", text: `${results.length > 1 ? `${Object.entries(counts).map(([key, count]) => `${count} ${key}`).join(", ")}\n\n` : ""}${text}` }],
				details: { results: results.map(({ text: _text, ...result }) => result) } };
		},
	});
}
