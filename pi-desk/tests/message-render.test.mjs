import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const require = createRequire(import.meta.url);
const directory = mkdtempSync(join(tmpdir(), "pi-desk-render-"));
let MessageView, DisclosureStates;
try {
	const file = join(directory, "view.mjs");
	await build({ stdin: { contents: 'export { MessageView } from "./message-view.tsx"; export { DisclosureStates } from "./disclosure.tsx";',
		resolveDir: fileURLToPath(new URL("../src/client", import.meta.url)), loader: "ts" },
		outfile: file, bundle: true, platform: "node", format: "esm", jsx: "automatic",
		banner: { js: 'import {createRequire} from "node:module"; const require=createRequire(import.meta.url); globalThis.history={state:null,length:1}; globalThis.location={hash:""}; globalThis.addEventListener=()=>{};' },
		plugins: [{ name: "shared-react", setup(builder) {
			builder.onResolve({ filter: /^react(?:-dom)?(?:\/.*)?$/ }, args => ({ path: require.resolve(args.path), external: true }));
		} }],
	});
	({ MessageView, DisclosureStates } = await import(pathToFileURL(file).href));
} finally { rmSync(directory, { recursive: true, force: true }); }

const message = (id, role, blocks) => ({ id, role, blocks, order: 0, revision: 1, timestamp: 0, complete: true });
const render = (props, states = new Map()) => renderToStaticMarkup(createElement(DisclosureStates.Provider, { value: states },
	createElement(MessageView, { sessionKey: "fixture", ...props })));

test("closed tool output and thinking do not build their hidden Markdown bodies", () => {
	const tool = message("tool", "tool", [{ type: "text", text: "HIDDEN_TOOL_BODY ".repeat(2000) }]);
	tool.toolName = "bash"; tool.toolCallId = "call";
	const thought = message("thought", "assistant", [{ type: "thinking", text: "HIDDEN_THINKING_BODY ".repeat(1000) }]);
	assert.doesNotMatch(render({ message: tool }), /HIDDEN_TOOL_BODY/);
	assert.doesNotMatch(render({ message: thought }), /HIDDEN_THINKING_BODY/);
	assert.match(render({ message: tool }, new Map([["tool:call", true]])), /HIDDEN_TOOL_BODY/);
	assert.match(render({ message: thought }, new Map([["thinking:thought:0", true]])), /HIDDEN_THINKING_BODY/);
});
