import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { outputArtifactStore } from "../pi-output-budget/extensions/index.ts";
import { browserMethod, compactDiff, snapshotFrom, SnapshotCache } from "./snapshots.ts";

const OBSERVATIONS = new Set(["browser_snapshot", "browser_navigate", "browser_navigate_back", "browser_click",
	"browser_type", "browser_fill_form", "browser_press_key", "browser_select_option", "browser_tabs",
	"browser_wait_for", "browser_drag", "browser_hover"]);

export default function browserContext(pi: ExtensionAPI) {
	const cache = new SnapshotCache();
	const calls = new Map<string, { generation: number; sequence: number }>();
	let generation = 0, sequence = 0, mode: "diff" | "full" = "diff";
	const reset = () => { generation++; calls.clear(); cache.clear(); };
	pi.on("session_start", reset);
	pi.on("session_tree", reset);
	pi.on("session_compact", reset);
	pi.on("session_shutdown", reset);

	pi.registerCommand("browser-context", {
		description: "Choose compact browser snapshot changes or full trees: /browser-context diff|full",
		async handler(args, ctx) {
			const next = args.trim().toLowerCase();
			if (next && next !== "diff" && next !== "full") { ctx.ui.notify("Use /browser-context diff or /browser-context full.", "error"); return; }
			if (next === "diff" || next === "full") { mode = next; reset(); }
			ctx.ui.notify(`Browser snapshots: ${mode}. Complete observations remain available through read_artifact.`, "info");
		},
	});

	pi.on("tool_call", event => {
		if (browserMethod(event.toolName, event.input)) calls.set(event.toolCallId, { generation, sequence: ++sequence });
	});
	pi.on("tool_result", async event => {
		const call = calls.get(event.toolCallId);
		calls.delete(event.toolCallId);
		const method = browserMethod(event.toolName, event.input);
		if (!call || call.generation !== generation || !method || !OBSERVATIONS.has(method) || event.isError || mode === "full") return;
		const capturedGeneration = generation;
		let input = event.input;
		if (event.toolName === "mcp" && typeof input.args === "string") {
			try { input = JSON.parse(input.args); } catch { return; }
		}
		const scope = JSON.stringify([input?.target ?? null, input?.depth ?? null, input?.boxes ?? false]);
		const content = [...event.content];
		let changed = false;
		for (let index = 0; index < content.length; index++) {
			const block = content[index];
			if (block?.type !== "text") continue;
			const snapshot = snapshotFrom(block.text, scope);
			if (!snapshot) continue;
			const previous = cache.get(snapshot.key);
			if (previous && previous.sequence >= call.sequence) continue;
			const diff = previous ? compactDiff(previous.tree, snapshot.tree) : undefined;
			// Archive the whole observation, including URL and tab metadata, before making omissions.
			let artifact: string;
			try { artifact = await outputArtifactStore().put(block.text); } catch { continue; }
			if (capturedGeneration !== generation) return;
			cache.set(snapshot.key, { tree: snapshot.tree, artifact, sequence: call.sequence });
			if (!previous || diff === undefined) continue;
			const replacement = `Changes since ${previous.artifact} (unchanged lines omitted):\n${diff}\n\nComplete current observation: ${artifact}; use read_artifact.\n`;
			if (replacement.length >= snapshot.end - snapshot.start) continue;
			content[index] = { ...block, text: block.text.slice(0, snapshot.start) + replacement + block.text.slice(snapshot.end) };
			changed = true;
		}
		if (changed) return { content };
	});
}
