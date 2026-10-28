import assert from "node:assert/strict";
import test from "node:test";
import { fromMarkdown } from "mdast-util-from-markdown";
import { dotMarkdown } from "../src/client/dot-markdown.ts";

const blocks = text => fromMarkdown(dotMarkdown(text)).children.map(node => node.type === "list"
	? { list: node.children.map(item => item.children[0].children.map(part => part.value ?? part.children?.[0]?.value).join("")) }
	: node.type === "code" ? { code: node.value } : { text: node.children.map(part => part.value ?? part.children?.[0]?.value).join("") });

test("Dot text renders as ChatGPT shows it: each line its own paragraph, and lines starting with • a list", () => {
	// The shape of Dot's daily reads (Desk showed the heading and items run together in one paragraph).
	assert.deepEqual(blocks([
		"Today’s worthwhile reads.", "", "Agent engineering",
		"• [Rethinking Verification](https://arxiv.org/abs/1) (Oct 25): Experiments favour a separate critic.",
		"• [Trial by Trace](https://arxiv.org/abs/2) (Oct 23): Trace checks.",
		"A closing note.",
		"Stremio is still logged out.",
		"```", "line one", "line two", "```",
	].join("\n")), [
		{ text: "Today’s worthwhile reads." }, { text: "Agent engineering" },
		{ list: ["Rethinking Verification (Oct 25): Experiments favour a separate critic.", "Trial by Trace (Oct 23): Trace checks."] },
		{ text: "A closing note." }, { text: "Stremio is still logged out." },
		{ code: "line one\nline two" },
	]);
	assert.equal(dotMarkdown("| a | b |\n|---|---|\n| 1 | 2 |"), "| a | b |\n|---|---|\n| 1 | 2 |");
});
