import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

type Model = NonNullable<ExtensionContext["model"]>;
type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type ServiceRequest = {
	path: string;
	codex: boolean;
	label: string;
	body: unknown;
	maxResponseBytes: number;
	maxErrorChars?: number;
	timeoutMs?: number;
};

export function serviceEndpoint(baseUrl: string, path: string, codex: boolean): string {
	let base = baseUrl.trim().replace(/\/+$/, "");
	if (!base) throw new Error("the selected model has no API base URL");
	if (base.endsWith("/responses")) base = base.slice(0, -"/responses".length);
	if (codex && !base.endsWith("/codex")) base += "/codex";
	return `${base}/${path}`;
}

function accountId(token: string): string {
	try {
		const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
		const id = payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
		if (typeof id === "string" && id.trim()) return id.trim();
	} catch {}
	throw new Error("Codex OAuth token has no ChatGPT account ID");
}

function requestHeaders(
	apiKey: string | undefined,
	overrides: Record<string, string | null> | undefined,
	codex: boolean,
): Headers {
	const headers = new Headers({ accept: "application/json", "content-type": "application/json" });
	if (apiKey) headers.set("authorization", `Bearer ${apiKey}`);
	if (codex) headers.set("originator", "pi");
	const overridden = new Set<string>();
	for (const [key, value] of Object.entries(overrides ?? {})) {
		overridden.add(key.toLowerCase());
		if (value === null) headers.delete(key);
		else headers.set(key, value);
	}
	if (codex && !overridden.has("chatgpt-account-id")) {
		const bearer = headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
		headers.set("chatgpt-account-id", accountId(bearer ?? ""));
	}
	return headers;
}

async function readResponse(response: Response, maxBytes: number, label: string, signal: AbortSignal): Promise<string> {
	const tooLarge = () => new Error(`${label} response is larger than ${maxBytes} bytes`);
	if (Number(response.headers.get("content-length")) > maxBytes) {
		void response.body?.cancel().catch(() => {});
		throw tooLarge();
	}
	if (!response.body) return "";
	const reader = response.body.getReader();
	const cancel = () => { void reader.cancel(signal.reason).catch(() => {}); };
	signal.addEventListener("abort", cancel, { once: true });
	const decoder = new TextDecoder();
	let bytes = 0, text = "";
	try {
		signal.throwIfAborted();
		for (;;) {
			const { done, value } = await reader.read();
			signal.throwIfAborted();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > maxBytes) throw tooLarge();
			text += decoder.decode(value, { stream: true });
		}
		return text + decoder.decode();
	} catch (error) {
		void reader.cancel(error).catch(() => {});
		throw error;
	} finally {
		signal.removeEventListener("abort", cancel);
		reader.releaseLock();
	}
}

/** The endpoint owns its payload and identity; the registry owns request auth. */
class ServiceAuthExpired extends Error {}

/**
 * Mark a provider's stored OAuth token expired so the next request refreshes it. ChatGPT can revoke a token
 * before its stated expiry (for example after signing in elsewhere); Pi only refreshes once that expiry has
 * passed, so without this a revoked token fails until then. Uses Pi's locked credential write; returns false
 * when this Pi does not expose its credential store.
 */
async function expireStoredToken(ctx: ExtensionContext, provider: string): Promise<boolean> {
	const store = (ctx.modelRegistry as unknown as { runtime?: { credentials?: { modify?: (id: string, fn: (current: any) => Promise<any>) => Promise<unknown> } } })
		.runtime?.credentials;
	if (typeof store?.modify !== "function") return false;
	let changed = false;
	await store.modify(provider, async current => {
		if (current?.type !== "oauth") return undefined;
		changed = true;
		return { ...current, expires: Date.now() - 1000 };
	});
	return changed;
}

export async function requestService(
	ctx: ExtensionContext,
	model: Model,
	request: ServiceRequest,
	signal?: AbortSignal,
	fetchImpl: Fetch = globalThis.fetch,
): Promise<string> {
	signal?.throwIfAborted();
	const deadline = new AbortController();
	const onAbort = () => deadline.abort(signal?.reason);
	signal?.addEventListener("abort", onAbort, { once: true });
	const timer = setTimeout(() => deadline.abort(new Error(`${request.label} request timed out`)), request.timeoutMs ?? 300_000);
	timer.unref();
	let rejectAbort: () => void;
	const aborted = new Promise<never>((_resolve, reject) => {
		rejectAbort = () => reject(deadline.signal.reason);
		deadline.signal.addEventListener("abort", rejectAbort, { once: true });
	});
	const perform = async () => {
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		deadline.signal.throwIfAborted();
		if (!auth.ok) throw new Error(auth.error);
		if (!auth.apiKey && !Object.values(auth.headers ?? {}).some(Boolean)) {
			throw new Error(`no API key or OAuth token is available for ${model.provider}`);
		}
		const response = await fetchImpl(serviceEndpoint(auth.baseUrl ?? model.baseUrl, request.path, request.codex), {
			method: "POST",
			headers: requestHeaders(auth.apiKey, auth.headers, request.codex),
			body: JSON.stringify(request.body),
			signal: deadline.signal,
		});
		const text = await readResponse(response, request.maxResponseBytes, request.label, deadline.signal);
		deadline.signal.throwIfAborted();
		if (response.status === 401) throw new ServiceAuthExpired(`${request.label} request failed (401): the ${model.provider} sign-in has expired or was revoked.`);
		if (!response.ok) {
			let message = text.trim() || response.statusText || "request failed";
			try {
				const payload = JSON.parse(text);
				if (typeof payload?.error?.message === "string" && payload.error.message.trim()) message = payload.error.message;
			} catch {}
			throw new Error(`${request.label} request failed (${response.status}): ${message.slice(0, request.maxErrorChars ?? 2_000)}`);
		}
		return text;
	};
	// A revoked sign-in is refreshed once and the request repeated.
	const attempt = async () => {
		try { return await perform(); }
		catch (error) {
			if (!(error instanceof ServiceAuthExpired)) throw error;
			if (!await expireStoredToken(ctx, model.provider).catch(() => false)) throw new Error(`${error.message} Sign in again in Desk Settings, Provider accounts.`);
			try { return await perform(); }
			catch (retry) {
				throw retry instanceof ServiceAuthExpired ? new Error(`${retry.message} Refreshing it did not help; sign in again in Desk Settings, Provider accounts.`) : retry;
			}
		}
	};
	try {
		return await Promise.race([attempt(), aborted]);
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
		deadline.signal.removeEventListener("abort", rejectAbort!);
	}
}
