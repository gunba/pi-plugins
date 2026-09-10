import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { rewriteFileLinks } from "./links.ts";

export default function localLinks(pi: ExtensionAPI): void {
	let cwd = process.cwd();
	// Keep stable history separate from changing streaming prefixes. A tiny shared
	// cache would reparse the entire history on every redraw once it filled up.
	const caches = [
		{ values: new Map<string, string>(), chars: 0, maxEntries: 512, maxChars: 1_048_576 },
		{ values: new Map<string, string>(), chars: 0, maxEntries: 4, maxChars: 262_144 },
	];
	const clear = () => {
		for (const cache of caches) { cache.values.clear(); cache.chars = 0; }
	};
	pi.on("session_start", (_event, ctx) => { cwd = ctx.cwd; clear(); });
	pi.on("before_agent_start", (_event, ctx) => {
		if (cwd !== ctx.cwd) { cwd = ctx.cwd; clear(); }
	});
	pi.on("session_shutdown", clear);
	pi.registerMarkdownTransformer((markdown, context) => {
		if (context.messageType === "user") return markdown;
		if (!markdown.includes("](") && !markdown.includes("]:")) return markdown;
		const cache = caches[context.isStreaming ? 1 : 0];
		const cached = cache.values.get(markdown);
		if (cached !== undefined) return cached;
		const result = rewriteFileLinks(markdown, cwd);
		const cost = markdown.length + result.length;
		if (cost <= cache.maxChars) {
			while (cache.values.size >= cache.maxEntries || cache.chars + cost > cache.maxChars) {
				const oldest = cache.values.keys().next().value!;
				cache.chars -= oldest.length + cache.values.get(oldest)!.length;
				cache.values.delete(oldest);
			}
			cache.values.set(markdown, result);
			cache.chars += cost;
		}
		return result;
	});
}
