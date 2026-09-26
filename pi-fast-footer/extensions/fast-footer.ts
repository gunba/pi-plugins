import { homedir } from "node:os";
import { isAbsolute, relative, sep } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { reduceSessionUsage } from "../../pi-session-usage/index.ts";

interface Totals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	cacheHitRate?: number;
}

interface Snapshot {
	totals: Totals;
	sessionName?: string;
	context: ReturnType<ExtensionContext["getContextUsage"]>;
}

function formatTokens(count: number): string {
	if (count < 1000) return `${count}`;
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

function formatCwd(cwd: string): string {
	const path = relative(homedir(), cwd);
	if (path === "") return "~";
	if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) return cwd;
	return `~${sep}${path}`;
}

function snapshot(ctx: ExtensionContext): Snapshot {
	const entries = ctx.sessionManager.getEntries();
	const { usage, cacheHitRate } = reduceSessionUsage(entries);
	const totals: Totals = {
		input: usage?.input ?? 0, output: usage?.output ?? 0,
		cacheRead: usage?.cacheRead ?? 0, cacheWrite: usage?.cacheWrite ?? 0,
		cost: usage?.cost.total ?? 0, cacheHitRate,
	};
	let sessionName: string | undefined;
	for (const entry of entries) {
		if (entry.type === "session_info") {
			sessionName = entry.name?.trim() || undefined;
		}
	}
	return { totals, sessionName, context: ctx.getContextUsage() };
}

export default function fastFooter(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		ctx.ui.setFooter((tui, theme, footerData) => {
			let previousSession: string | undefined;
			let previousLeaf: string | null | undefined;
			let previousModel: string | undefined;
			let cached: Snapshot | undefined;
			const cwd = formatCwd(ctx.sessionManager.getCwd());
			const unsubscribe = footerData.onBranchChange(() => tui.requestRender());

			return {
				dispose: unsubscribe,
				invalidate() {},
				render(width: number): string[] {
					const manager = ctx.sessionManager;
					const sessionId = manager.getSessionId();
					const leafId = manager.getLeafId();
					const model = ctx.model;
					const modelId = model ? `${model.provider}/${model.id}` : undefined;
					if (!cached || sessionId !== previousSession || leafId !== previousLeaf || modelId !== previousModel) {
						cached = snapshot(ctx);
						previousSession = sessionId;
						previousLeaf = leafId;
						previousModel = modelId;
					}

					const branch = footerData.getGitBranch();
					const title = `${cwd}${branch ? ` (${branch})` : ""}${cached.sessionName ? ` • ${cached.sessionName}` : ""}`;
					const totals = cached.totals;
					const stats: string[] = [];
					if (totals.input) stats.push(`↑${formatTokens(totals.input)}`);
					if (totals.output) stats.push(`↓${formatTokens(totals.output)}`);
					if (totals.cacheRead) stats.push(`R${formatTokens(totals.cacheRead)}`);
					if (totals.cacheWrite) stats.push(`W${formatTokens(totals.cacheWrite)}`);
					if ((totals.cacheRead || totals.cacheWrite) && totals.cacheHitRate !== undefined) {
						stats.push(`CH${totals.cacheHitRate.toFixed(1)}%`);
					}
					if (totals.cost) stats.push(`$${totals.cost.toFixed(3)}`);

					const contextWindow = cached.context?.contextWindow ?? model?.contextWindow ?? 0;
					const percent = cached.context?.percent;
					const contextText = `${percent == null ? "?" : `${percent.toFixed(1)}%`}/${formatTokens(contextWindow)}`;
					stats.push(percent != null && percent > 90
						? theme.fg("error", contextText)
						: percent != null && percent > 70
							? theme.fg("warning", contextText)
							: contextText);

					const thinking = model?.reasoning
						? ` • ${ctx.thinkingLevel && ctx.thinkingLevel !== "off" ? ctx.thinkingLevel : "thinking off"}`
						: "";
					const modelName = `${model?.id ?? "no-model"}${thinking}`;
					let left = stats.join(" ");
					if (visibleWidth(left) > width) left = truncateToWidth(left, width, "...");
					const leftWidth = visibleWidth(left);
					const withProvider = model && footerData.getAvailableProviderCount() > 1
						? `(${model.provider}) ${modelName}` : modelName;
					const right = leftWidth + 2 + visibleWidth(withProvider) <= width ? withProvider : modelName;
					const rightSpace = Math.max(0, width - leftWidth - 2);
					const fittedRight = truncateToWidth(right, rightSpace, "");
					const padding = " ".repeat(Math.max(0, width - leftWidth - visibleWidth(fittedRight)));
					const statusLine = theme.fg("dim", left) + theme.fg("dim", padding + fittedRight);
					const lines = [truncateToWidth(theme.fg("dim", title), width), statusLine];
					const statuses = [...footerData.getExtensionStatuses()]
						.sort(([a], [b]) => a.localeCompare(b))
						.map(([, text]) => text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim());
					if (statuses.length) lines.push(truncateToWidth(statuses.join(" "), width));
					return lines;
				},
			};
		});
	});
}
