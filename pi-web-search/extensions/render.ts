import { stripVTControlCharacters } from "node:util";
import type { AgentToolResult, Theme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";

/** Display Codex's content-reference notation without changing tool evidence. */
export function searchDisplayText(text: string): string {
	return stripVTControlCharacters(text)
		.replace(/\uE200cite\uE202([^\uE200\uE201]*)\uE201/gu, (_marker, payload: string) => {
			return payload.split("\uE202").map(reference => {
				const [id, label, ...description] = reference.split("†");
				return label === undefined
					? `[${id}]`
					: `[${id}] ${label}${description.length ? ` (${description.join(" · ")})` : ""}`;
			}).join(" ");
		})
		.replace(/\uE200([^\uE200\uE201]*)\uE201/gu, (_marker, payload: string) =>
			`[${payload.split("\uE202").join(": ")}]`)
		// Incomplete markers can occur in a partial or truncated result.
		.replaceAll("\uE200", "[")
		.replaceAll("\uE201", "]")
		.replaceAll("\uE202", ": ")
		.replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/gu, "");
}

export function renderSearchResult(
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
): Component {
	const text = result.content.filter(block => block.type === "text").map(block => block.text).join("\n");
	const displayText = searchDisplayText(text);
	const view = new Text(theme.fg("toolOutput", displayText), 0, 0);
	let cachedWidth: number | undefined;
	let cachedExpanded: boolean | undefined;
	let cachedLines: string[] | undefined;
	return {
		render(width) {
			if (cachedLines && cachedWidth === width && cachedExpanded === options.expanded) return cachedLines;
			const lines = view.render(width);
			const collapsed = !options.expanded && lines.length > 10;
			// Regular-mode redraws visit historical rows on every keystroke.
			// Clamp only displayed lines, then cache the complete presentation.
			cachedLines = (collapsed ? lines.slice(0, 10) : lines).map(line => truncateToWidth(line, width));
			if (collapsed) cachedLines.push(theme.fg("dim", truncateToWidth(`… (${lines.length - 10} more lines)`, width)));
			cachedWidth = width;
			cachedExpanded = options.expanded;
			return cachedLines;
		},
		invalidate() {
			cachedLines = undefined;
			view.setText(theme.fg("toolOutput", displayText));
			view.invalidate();
		},
	};
}
