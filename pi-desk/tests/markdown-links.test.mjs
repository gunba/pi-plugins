import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "react-markdown";
import { Transcript } from "../src/host/transcript.ts";
import { fileLinkPlugin, markdownUrl } from "../src/client/markdown-links.ts";

test("Markdown URI encoding does not strip a projected local file link", () => {
	const text = "[Report](<Work files/Report.docx>)";
	const message = new Transcript().message({ role: "assistant", content: [{ type: "text", text }] }, "report", undefined, 0, process.cwd());
	assert.equal(message.links[0].target, "Work files/Report.docx");
	const markup = renderToStaticMarkup(React.createElement(Markdown, {
		remarkPlugins: [fileLinkPlugin(message.links)],
		urlTransform: url => markdownUrl(message.links, url),
	}, text));
	assert.equal(markup, `<p><a href="#desk-file-${message.links[0].file.id}">Report</a></p>`);
});
