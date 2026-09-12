import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { getAgentDir, SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function parseLimit(value: string, window: number, keepRecent: number): number {
	const match = /^(\d+(?:\.\d+)?)\s*(k|m)?$/i.exec(value.trim());
	if (!match) throw new Error("Use a token count such as 160k or 200000.");
	const tokens = Number(match[1]) * (match[2]?.toLowerCase() === "m" ? 1_000_000 : match[2] ? 1_000 : 1);
	if (!Number.isSafeInteger(tokens) || tokens <= keepRecent || tokens >= window) {
		throw new Error(`Use more than ${keepRecent.toLocaleString()} and less than ${window.toLocaleString()} tokens.`);
	}
	return tokens;
}

export function withReserve(text: string | undefined, reserveTokens: number): string {
	const settings = text === undefined ? {} : JSON.parse(text);
	if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new Error("Settings must be a JSON object.");
	if (settings.compaction !== undefined && (!settings.compaction || typeof settings.compaction !== "object" || Array.isArray(settings.compaction))) {
		throw new Error("Compaction settings must be a JSON object.");
	}
	return JSON.stringify({ ...settings, compaction: { ...settings.compaction, reserveTokens } }, null, 2) + "\n";
}

/** Uses the same .lock directory as native FileSettingsStorage; never steals a held lock. */
export function writeReserve(directory: string, reserve: number) {
	const path = join(directory, "settings.json");
	const temporary = join(directory, `.settings-${randomUUID()}.tmp`);
	mkdirSync(directory, { recursive: true });
	mkdirSync(`${path}.lock`);
	try {
		let current: string | undefined;
		try { current = readFileSync(path, "utf8"); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		writeFileSync(temporary, withReserve(current, reserve), { flag: "wx", mode: 0o600 });
		renameSync(temporary, path);
	} finally { rmSync(temporary, { force: true }); rmSync(`${path}.lock`, { recursive: true }); }
}

export default function contextLimit(pi: ExtensionAPI) {
	pi.registerCommand("context-limit", {
		description: "Show or change the automatic compaction threshold: /context-limit 200k",
		handler: async (args, ctx) => {
			if (!ctx.model) { ctx.ui.notify("Select a model first.", "error"); return; }
			try {
				if (args.trim()) await ctx.waitForIdle();
				const settings = SettingsManager.create(ctx.cwd, getAgentDir(), { projectTrusted: ctx.isProjectTrusted() });
				const errors = settings.drainErrors();
				if (errors.length) throw errors[0]!.error;
				const project = settings.getProjectSettings();
				const reserve = settings.getCompactionReserveTokens();
				const keep = settings.getCompactionKeepRecentTokens();
				const window = ctx.model.contextWindow;
				if (!args.trim()) {
					ctx.ui.notify(`Saved compaction setting: about ${(window - reserve).toLocaleString()} / ${window.toLocaleString()} tokens (${reserve.toLocaleString()} reserved).${!settings.getCompactionEnabled() ? " Automatic compaction is disabled." : ""}`, "info");
					return;
				}
				// Do not overwrite workspace settings or silently report an ineffective global change.
				if (ctx.isProjectTrusted() && project.compaction?.reserveTokens !== undefined) throw new Error("This workspace overrides compaction.reserveTokens. Change that workspace setting before using the global command.");
				const tokens = parseLimit(args, window, keep);
				writeReserve(getAgentDir(), window - tokens);
				ctx.ui.notify(`Compaction threshold set to about ${tokens.toLocaleString()} tokens for ${ctx.model.name}. Reloading extensions to apply it; no restart is needed.`, "info");
				await ctx.reload();
			} catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
		},
	});
}
