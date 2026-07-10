import assert from "node:assert/strict";
import test from "node:test";

import codexCompat from "../extensions/codex-compat.ts";

function registeredTools() {
	const tools = new Map();
	codexCompat({
		getActiveTools: () => [],
		setActiveTools() {},
		on() {},
		registerCommand() {},
		registerTool(tool) {
			tools.set(tool.name, tool);
		},
	});
	return tools;
}

test("shell_command keeps the context-mode raw HTTP guardrail", async () => {
	const shellCommand = registeredTools().get("shell_command");
	assert.ok(shellCommand);
	const result = await shellCommand.execute(
		"guard-test",
		{ command: "curl https://example.com", workdir: process.cwd() },
		undefined,
		undefined,
		{ cwd: process.cwd() },
	);
	assert.equal(result.isError, true);
	assert.match(result.content[0].text, /blocked by pi-codex-compat/);
	assert.match(result.content[0].text, /context-mode/);
});

test("custom command renderers collapse successes and retain expanded or error output", () => {
	const tools = registeredTools();
	const theme = {
		fg: (_color, text) => text,
		bold: (text) => text,
	};
	const render = (component) => component.render(200).join("\n").trimEnd();
	const options = { expanded: false, isPartial: false };

	const shellCommand = tools.get("shell_command");
	const shellResult = {
		content: [{ type: "text", text: "full command output" }],
		details: { running: false, exit_code: 0 },
	};
	assert.equal(
		render(
			shellCommand.renderResult(shellResult, options, theme, {
				isError: false,
				lastComponent: undefined,
			}),
		),
		"✓ Completed",
	);
	assert.match(
		render(
			shellCommand.renderResult(
				shellResult,
				{ ...options, expanded: true },
				theme,
				{ isError: false, lastComponent: undefined },
			),
		),
		/full command output/,
	);
	assert.match(
		render(
			shellCommand.renderResult(
				{ ...shellResult, details: { running: false, error: "boom" } },
				options,
				theme,
				{ isError: true, lastComponent: undefined },
			),
		),
		/full command output/,
	);

	const applyPatch = tools.get("apply_patch");
	assert.equal(
		render(
			applyPatch.renderResult(
				{
					content: [{ type: "text", text: "Applied patch.\n- updated a.ts" }],
					details: { changes: [{ action: "updated", path: "a.ts" }] },
				},
				options,
				theme,
				{ isError: false, lastComponent: undefined },
			),
		),
		"✓ Patched 1 file",
	);
});
