import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "react-markdown";
import { Transcript } from "../src/host/transcript.ts";
import { markdownPlugins, markdownUrl } from "../src/client/markdown-links.ts";

test("Markdown URI encoding does not strip a projected local file link", () => {
	const text = "[Report](<Work files/Report.docx>)";
	const message = new Transcript().message({ role: "assistant", content: [{ type: "text", text }] }, "report", undefined, 0, process.cwd());
	assert.equal(message.links[0].target, "Work files/Report.docx");
	const markup = renderToStaticMarkup(React.createElement(Markdown, {
		remarkPlugins: markdownPlugins(message.links),
		urlTransform: url => markdownUrl(message.links, url),
	}, text));
	assert.equal(markup, `<p><a href="#desk-file-${message.links[0].file.id}">Report</a></p>`);
});

test("chat Markdown renders reconciliation tables instead of literal pipes", () => {
	const text = "| Calculation | Amount |\n|---|---:|\n| Annual package | $171,664.45 |\n| **Total** | **$175,954.25** |";
	const markup = renderToStaticMarkup(React.createElement(Markdown, { remarkPlugins: markdownPlugins() }, text));
	assert.match(markup, /<table>/);
	assert.match(markup, /<th>Calculation<\/th>/);
	assert.match(markup, /<td style="text-align:right">\$171,664\.45<\/td>/);
	assert.match(markup, /<strong>\$175,954\.25<\/strong>/);
});
