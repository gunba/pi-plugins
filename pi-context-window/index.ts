import { SettingsManager, getAgentDir, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getPresentation, type UiDetails } from "../pi-ui/index.ts";
import { SelectList, truncateToWidth, type SelectItem } from "@earendil-works/pi-tui";
import {
	EXTENDED_CHECKPOINT, EXTENDED_RESERVE, EXTENDED_WINDOW, allowsExtendedWindow,
	configuredReserve, configuredWindow, readWindowFiles, writeWindowPreset,
} from "./config.ts";

function tokens(value: number): string { return value.toLocaleString("en-US"); }

async function selectPreset(pi: ExtensionAPI, ctx: ExtensionCommandContext, lines: string[], items: SelectItem[], selected: number): Promise<string | null> {
	const remote = getPresentation(pi);
	if (remote?.capabilities.includes("questions")) {
		const answer = await remote.request({ kind: "question", title: "Context capacity", context: lines.join("\n"),
			options: items.map(item => ({ title: item.label, description: item.description })),
			allowMultiple: false, allowFreeform: false, allowComment: false });
		return answer?.kind === "selection" ? items.find(item => item.label === answer.selections[0])?.value ?? null : null;
	}
	return ctx.ui.custom<string | null>((tui, theme, _keys, done) => {
		const list = new SelectList(items, items.length, {
			selectedPrefix: text => theme.fg("accent", text),
			selectedText: text => theme.fg("accent", text),
			description: text => theme.fg("muted", text),
			scrollInfo: text => theme.fg("dim", text),
			noMatch: text => theme.fg("warning", text),
		});
		list.setSelectedIndex(selected);
		list.onSelect = item => done(item.value);
		list.onCancel = () => done(null);
		return {
			render(width: number) {
				return [
					...lines.map((line, index) => truncateToWidth(index === 0 ? theme.fg("accent", theme.bold(line)) : theme.fg("muted", line), width)),
					"", ...list.render(width),
					"", truncateToWidth(theme.fg("dim", "↑↓ choose · Enter apply · Esc cancel"), width),
				];
			},
			invalidate() { list.invalidate(); },
			handleInput(data: string) { list.handleInput(data); tui.requestRender(); },
		};
	}, { overlay: true, overlayOptions: { anchor: "center", width: 78, maxHeight: 14 } });
}

function contextSettings(ctx: ExtensionContext) {
	const model = ctx.model;
	if (!model) throw new Error("Select a model first.");
	const { provider, id } = model, files = readWindowFiles();
	const override = configuredWindow(files.models, provider, id);
	const reserve = configuredReserve(files.settings, provider, id);
	const settings = SettingsManager.create(ctx.cwd, getAgentDir(), { projectTrusted: ctx.isProjectTrusted() });
	const errors = settings.drainErrors();
	if (errors.length) throw errors[0]!.error;
	const projectReserve = ctx.isProjectTrusted()
		? configuredReserve(JSON.stringify(settings.getProjectSettings()), provider, id) : undefined;
	const effectiveReserve = projectReserve ?? reserve ?? settings.getCompactionReserveTokens();
	const enabled = settings.getCompactionEnabled(), extended = allowsExtendedWindow(provider, id);
	const mechanism = provider === "openai-codex" ? "Codex checkpoint" : "Pi compaction";
	const checkpoint = !enabled ? "Automatic compaction off"
		: effectiveReserve >= model.contextWindow ? `${mechanism} reserve exceeds the model window`
		: `${mechanism} near ${tokens(model.contextWindow - effectiveReserve)}`;
	const lines = [
		`Context · ${provider}/${id}`,
		`This session: ${tokens(model.contextWindow)} tokens`,
		...(override !== undefined && override !== model.contextWindow ? [`Saved: ${tokens(override)} tokens; reload to apply it.`] : []),
		enabled ? `${checkpoint} · ${projectReserve !== undefined ? "workspace override" : "model/global reserve"}` : checkpoint,
		...(extended ? ["OpenAI model capacity: 1,050,000; Codex catalog may choose a lower default."] : []),
	];
	return { model, provider, id, override, reserve, settings, projectReserve, enabled, extended, mechanism, lines };
}

export default function contextWindow(pi: ExtensionAPI): void {
	let revision = 0;
	const publish = (ctx: ExtensionContext) => {
		const remote = getPresentation(pi);
		if (!remote?.runCommand) return;
		let data: UiDetails;
		try {
			const current = contextSettings(ctx), usage = ctx.getContextUsage();
			data = { summary: current.lines.join("\n"), fields: [
				{ label: "Current conversation", value: usage?.tokens == null ? "Not measured yet" : `${tokens(usage.tokens)} tokens${usage.percent == null ? "" : ` · ${usage.percent.toFixed(1)}%`}` },
				{ label: "Capacity", value: "Applies to this model. Other running sessions need reload after a change." },
			] };
		} catch (error) { data = { summary: error instanceof Error ? error.message : String(error) }; }
		remote.publish("context-window", { kind: "details", surface: "settings", title: "Context capacity", data,
			actions: [{ id: "configure", label: "Choose capacity" }, { id: "refresh", label: "Refresh" }] },
			{ configure: () => remote.runCommand!("context-window"), refresh: () => publish(ctx) });
	};
	pi.on("session_start", (_event, ctx) => { revision++; publish(ctx); });
	pi.on("session_tree", (_event, ctx) => { revision++; publish(ctx); });
	pi.on("session_shutdown", () => { revision++; });
	pi.on("model_select", (_event, ctx) => publish(ctx));
	pi.on("session_compact", (_event, ctx) => publish(ctx));
	pi.on("agent_settled", (_event, ctx) => publish(ctx));
	pi.registerCommand("context-window", {
		description: "Choose the active model's context window and automatic checkpoint threshold.",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui" && !getPresentation(pi)?.capabilities.includes("questions")) { ctx.ui.notify("Context settings require an interactive presentation.", "error"); return; }
			if (args.trim()) { ctx.ui.notify("Open /context-window without arguments to choose in the dialog.", "error"); return; }
			if (!ctx.model) { ctx.ui.notify("Select a model first.", "error"); return; }
			try {
				await ctx.waitForIdle();
				const { provider, id, override, reserve, settings, projectReserve, enabled, extended, mechanism, lines } = contextSettings(ctx);
				const captured = revision, session = ctx.sessionManager.getSessionId();
				const assertCurrent = () => {
					if (revision !== captured || ctx.sessionManager.getSessionId() !== session ||
						ctx.model?.provider !== provider || ctx.model.id !== id || !ctx.isIdle())
						throw new Error("The session or model changed. Reopen context settings.");
				};
				const items: SelectItem[] = [
					{ value: "catalog", label: "Use Pi catalog settings",
						description: "Remove this model's window and checkpoint overrides." },
					...(extended ? [{ value: "extended", label: enabled ? "1M window · 900K checkpoint" : "1M window · compaction off",
						description: "Opt in for this model; long context can use more quota." }] : []),
				];
				const selected = override === EXTENDED_WINDOW && reserve === EXTENDED_RESERVE ? 1 : 0;
				const choice = await selectPreset(pi, ctx, lines, items, selected);
				if (!choice) return;
				assertCurrent();
				if (projectReserve !== undefined) {
					throw new Error("This workspace overrides the model's checkpoint reserve. Change that workspace setting first.");
				}
				if (choice === "extended" && !await ctx.ui.confirm(
					"Use extended context for this model?",
					`Pi will use ${tokens(EXTENDED_WINDOW)} tokens${enabled ? ` and checkpoint near ${tokens(EXTENDED_CHECKPOINT)}` : "; automatic compaction remains off"}. Long prompts can use more quota. The endpoint may still enforce its own limit.`,
				)) return;
				if (choice === "catalog" && (override !== undefined || reserve !== undefined) &&
					!await ctx.ui.confirm("Restore catalog settings?",
						"Remove this model's window and checkpoint overrides. Other model settings stay unchanged.")) return;
				const target = choice === "extended" ? EXTENDED_WINDOW : undefined;
				const changed = await writeWindowPreset({
					provider, modelId: id, window: target,
					reserve: choice === "extended" ? EXTENDED_RESERVE : undefined,
				}, { assertCurrent, expected: { window: override, reserve } });
				if (!changed) { ctx.ui.notify("Context settings are already selected.", "info"); return; }
				await ctx.modelRegistry.refresh({ providers: [provider], allowNetwork: false });
				const current = ctx.modelRegistry.find(provider, id);
				if (ctx.modelRegistry.getError() || !current || (target !== undefined && current.contextWindow !== target)) {
					throw new Error(ctx.modelRegistry.getError() ?? "Saved model context could not be applied; inspect models.json.");
				}
				if (!await pi.setModel(current)) throw new Error("Saved context settings, but model authentication is unavailable.");
				ctx.ui.notify(`Context set to ${tokens(current.contextWindow)}; ${enabled ? `${mechanism.toLowerCase()} near ${tokens(current.contextWindow - (choice === "extended" ? EXTENDED_RESERVE : settings.getCompactionReserveTokens()))}` : "automatic compaction off"}. Reloading settings.`, "info");
				await ctx.reload();
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}
