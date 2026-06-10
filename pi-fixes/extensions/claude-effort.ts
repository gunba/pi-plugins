import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Lift Anthropic effort to Claude's top tier.
//
// Pi's ThinkingLevel hard-stops at "xhigh", but Claude Fable 5 and Opus 4.7+ expose a
// higher "max" effort ("absolute maximum capability"). On Fable 5 and
// opus-4-8 Pi maps xhigh -> effort "xhigh", so "max" is unreachable. Until upstream issue #5361
// adds a real "max" level, we remap on the wire so Pi's five non-off thinking
// levels map 1:1 onto Anthropic's ladder  low < medium < high < xhigh < max.
//
// Mechanism: the Anthropic SDK issues requests through global fetch with a JSON
// string body carrying `output_config.effort` (adaptive thinking). We wrap fetch
// — sharing the patch-stack convention used by codex-transport and pi-usage so
// the wrappers compose — and rewrite that one field for max-capable Opus models.
// Anything unexpected falls through untouched; the remap can never break a request.

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
type Effort = "low" | "medium" | "high" | "xhigh" | "max";

const FETCH_PATCH_STACK_KEY = Symbol.for("pi.fetchPatchStack");
const EFFECTIVENESS_KEY = Symbol.for("pi.fixes.effectiveness");
const PATCH_ID = "pi-fixes-claude-effort@1";

// Pi thinking level -> Anthropic effort: a 1:1 shift onto the top of the ladder.
const LEVEL_TO_EFFORT: Record<Exclude<ThinkingLevel, "off">, Effort> = {
	minimal: "low",
	low: "medium",
	medium: "high",
	high: "xhigh",
	xhigh: "max",
};
const EFFORT_LADDER: Effort[] = ["low", "medium", "high", "xhigh", "max"];

// Only models with the full Anthropic effort ladder (`low` through `max`) can
// safely receive the 1-rung lift. Keep this allowlist narrow so we never send
// an effort a model would reject.
const MAX_CAPABLE_MODEL_RE = /^claude-(?:fable-5|opus-4-(?:[7-9]|\d{2,}))/;

let currentLevel: ThinkingLevel | undefined;

function recordFix(fixId: string, count = 1): void {
	try {
		const tracker = (globalThis as Record<symbol, unknown>)[EFFECTIVENESS_KEY] as { record?: (id: string, n?: number) => void } | undefined;
		tracker?.record?.(fixId, count);
	} catch {
		// Effectiveness tracking is best-effort and must never disrupt the fix.
	}
}

function targetEffort(wireEffort: string): Effort | undefined {
	// Prefer a precise 1:1 from the actual Pi thinking level.
	if (currentLevel && currentLevel !== "off") return LEVEL_TO_EFFORT[currentLevel];
	// Fallback when the level was not captured: bump the wire effort one rung.
	const index = EFFORT_LADDER.indexOf(wireEffort as Effort);
	return index >= 0 ? EFFORT_LADDER[Math.min(index + 1, EFFORT_LADDER.length - 1)] : undefined;
}

function rewriteBody(bodyText: string): string | undefined {
	let body: Record<string, unknown>;
	try {
		body = JSON.parse(bodyText) as Record<string, unknown>;
	} catch {
		return undefined;
	}
	if (!body || typeof body.model !== "string" || !MAX_CAPABLE_MODEL_RE.test(body.model)) return undefined;
	const outputConfig = body.output_config as { effort?: unknown } | undefined;
	if (!outputConfig || typeof outputConfig.effort !== "string") return undefined;
	const next = targetEffort(outputConfig.effort);
	if (!next || next === outputConfig.effort) return undefined;
	outputConfig.effort = next;
	recordFix("claude-effort-remap");
	return JSON.stringify(body);
}

function fetchPatchStack(value: unknown): string[] {
	if (typeof value !== "function") return [];
	const stack = Reflect.get(value, FETCH_PATCH_STACK_KEY);
	return Array.isArray(stack) ? stack.filter((item): item is string => typeof item === "string") : [];
}

function installPatch(): void {
	if (typeof globalThis.fetch !== "function") return;
	const stack = fetchPatchStack(globalThis.fetch);
	if (stack.includes(PATCH_ID)) return;
	const downstream = globalThis.fetch.bind(globalThis) as typeof fetch;
	const wrapped = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		try {
			const body = init?.body;
			if (typeof body === "string" && body.includes("output_config")) {
				const rewritten = rewriteBody(body);
				if (rewritten !== undefined) {
					const headers = new Headers(init?.headers as HeadersInit | undefined);
					headers.delete("content-length"); // length changed; let fetch recompute it
					return downstream(input, { ...init, body: rewritten, headers });
				}
			}
		} catch {
			// Never let the remap break a request.
		}
		return downstream(input, init);
	}) as typeof fetch;
	Object.defineProperty(wrapped, FETCH_PATCH_STACK_KEY, { value: [...stack, PATCH_ID], enumerable: false, configurable: false });
	globalThis.fetch = wrapped;
}

export default function claudeEffort(pi: ExtensionAPI) {
	const capture = () => {
		try {
			currentLevel = pi.getThinkingLevel() as ThinkingLevel;
		} catch {
			// thinking level is best-effort; the wire-bump fallback covers gaps
		}
	};

	installPatch();
	capture();

	// Pi installs undici after extension load (which can replace global fetch),
	// so re-apply lazily before requests — same pattern as codex-transport.
	pi.on("session_start", async () => {
		installPatch();
		capture();
	});
	pi.on("before_provider_request", async () => {
		installPatch();
		capture();
	});
	pi.on("model_select", async () => capture());
	pi.on("thinking_level_select", async () => capture());
}
