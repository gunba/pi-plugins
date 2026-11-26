import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { rewriteFileLinks } from "./links.ts";

const EXAMPLE = process.platform === "win32" ? "[Project Plan.docx](<C:\\Work\\Project Plan.docx>)" : "[plan.md](</home/me/work/plan.md>)";
const GUIDANCE = `### Local files
Name each file or folder on this computer in a reply by its absolute path, as a Markdown link such as ${EXAMPLE} or in backticks: the user opens those with a click, and can't open a bare name listed under a folder.`;

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
	pi.on("before_agent_start", (event, ctx) => {
		if (cwd !== ctx.cwd) { cwd = ctx.cwd; clear(); }
		const options = event.systemPromptOptions;
		options.appendSystemPrompt = options.appendSystemPrompt ? `${options.appendSystemPrompt}\n\n${GUIDANCE}` : GUIDANCE;
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
