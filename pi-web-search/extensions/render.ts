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
	const view = new Text(theme.fg("toolOutput", searchDisplayText(text)), 0, 0);
	return {
		render(width) {
			const lines = view.render(width).map(line => truncateToWidth(line, width));
			if (options.expanded || lines.length <= 10) return lines;
			return [...lines.slice(0, 10), theme.fg("dim", truncateToWidth(`… (${lines.length - 10} more lines)`, width))];
		},
		invalidate() { view.invalidate(); },
	};
}
