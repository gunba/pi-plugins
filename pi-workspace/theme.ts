import { Theme, type ThemeColor } from "@earendil-works/pi-coding-agent";
import {
	KeybindingsManager,
	TUI_KEYBINDINGS,
	type KeybindingsConfig,
	type KeyId,
} from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export function workspaceTheme(): Theme {
	const colors = Object.fromEntries(
		"accent border borderAccent borderMuted success error warning muted dim text thinkingText scrollbarTrack scrollbarThumb searchMatchText userMessageText customMessageText customMessageLabel toolTitle toolOutput mdHeading mdLink mdLinkUrl mdCode mdCodeBlock mdCodeBlockBorder mdQuote mdQuoteBorder mdHr mdListBullet toolDiffAdded toolDiffRemoved toolDiffContext syntaxComment syntaxKeyword syntaxFunction syntaxVariable syntaxString syntaxNumber syntaxType syntaxOperator syntaxPunctuation thinkingOff thinkingMinimal thinkingLow thinkingMedium thinkingHigh thinkingXhigh thinkingMax bashMode"
			.split(" ")
			.map((key) => [key, "#c8d3e0"]),
	) as Record<ThemeColor, string>;
	Object.assign(colors, {
		accent: "#8abeb7",
		border: "#354052",
		borderAccent: "#8abeb7",
		borderMuted: "#354052",
		muted: "#8d9bad",
		dim: "#627085",
		success: "#9ac98a",
		error: "#e58a86",
		warning: "#e4bb7b",
		toolDiffAdded: "#9ac98a",
		toolDiffRemoved: "#e58a86",
		toolDiffContext: "#8d9bad",
		scrollbarTrack: "#354052",
		scrollbarThumb: "#8d9bad",
	});
	return new Theme(
		colors,
		{
			selectedBg: "#293648",
			searchMatchBg: "#394853",
			userMessageBg: "#242c38",
			customMessageBg: "#282b3b",
			toolPendingBg: "#272c37",
			toolSuccessBg: "#26332d",
			toolErrorBg: "#39292e",
		},
		"truecolor",
		{ name: "workspace" },
	);
}

const APP_KEYS: Record<string, KeyId | KeyId[]> = {
	"app.interrupt": "escape",
	"app.clear": "ctrl+c",
	"app.exit": "ctrl+d",
	"app.model.select": "ctrl+l",
	"app.model.cycleForward": "ctrl+p",
	"app.model.cycleBackward": "shift+ctrl+p",
	"app.thinking.cycle": "shift+tab",
	"app.tools.expand": "ctrl+o",
	"app.thinking.toggle": "ctrl+t",
	"app.message.followUp": "alt+enter",
	"app.clipboard.pasteImage": "ctrl+v",
	"app.session.new": "ctrl+n",
	"app.session.resume": "ctrl+r",
	"app.session.tree": "alt+t",
	"app.session.toggleNamedFilter": "ctrl+n",
	"app.tree.foldOrUp": "left",
	"app.tree.unfoldOrDown": "right",
	"app.tree.editLabel": "ctrl+l",
	"app.tree.toggleLabelTimestamp": "ctrl+shift+t",
	"app.tree.filter.default": "ctrl+d",
	"app.tree.filter.noTools": "ctrl+t",
	"app.tree.filter.userOnly": "ctrl+u",
	"app.tree.filter.labeledOnly": "ctrl+l",
	"app.tree.filter.all": "ctrl+a",
	"app.tree.filter.cycleForward": "ctrl+o",
	"app.tree.filter.cycleBackward": "shift+ctrl+o",
};

/** Frontend bindings, sharing Pi's configured key names and the public TUI registry. */
export class WorkspaceKeys extends KeybindingsManager {
	private path: string;
	constructor(agentDir: string) {
		super({
			...TUI_KEYBINDINGS,
			...Object.fromEntries(
				Object.entries(APP_KEYS).map(([name, defaultKeys]) => [name, { defaultKeys }]),
			),
		});
		this.path = join(agentDir, "keybindings.json");
		this.reload();
	}
	reload(): void {
		try {
			this.setUserBindings(JSON.parse(readFileSync(this.path, "utf8")) as KeybindingsConfig);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	getEffectiveConfig(): KeybindingsConfig {
		return this.getResolvedBindings();
	}
}
