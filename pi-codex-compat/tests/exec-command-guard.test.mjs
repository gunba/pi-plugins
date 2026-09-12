import assert from "node:assert/strict";
import test from "node:test";

import codexCompat from "../extensions/codex-compat.ts";

function registeredTools() {
	const tools = new Map();
	codexCompat({
		events: { on: () => () => {} },
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

test("exec_command is a hard-cut strict Unified Exec schema", () => {
	const tools = registeredTools();
	const execCommand = tools.get("exec_command");
	const writeStdin = tools.get("write_stdin");
	assert.ok(execCommand);
	assert.ok(writeStdin);
	assert.equal(tools.has("shell_command"), false);
	assert.deepEqual(execCommand.parameters.required, ["cmd"]);
	assert.equal(execCommand.parameters.additionalProperties, false);
	assert.deepEqual(Object.keys(execCommand.parameters.properties).sort(), [
		"cmd",
		"login",
		"max_output_tokens",
		"shell",
		"tty",
		"workdir",
		"yield_time_ms",
	]);
	assert.equal("command" in execCommand.parameters.properties, false);
	assert.equal("timeout_ms" in execCommand.parameters.properties, false);
	assert.match(
		execCommand.parameters.properties.max_output_tokens.description,
		/Defaults to 10000 tokens/,
	);
	assert.match(
		execCommand.parameters.properties.yield_time_ms.description,
		/2000-30000 ms on Windows/,
	);
	assert.match(
		execCommand.parameters.properties.tty.description,
		/true is rejected/,
	);
	assert.equal(execCommand.parameters.properties.yield_time_ms.type, "integer");
	assert.equal(
		execCommand.parameters.properties.max_output_tokens.type,
		"integer",
	);
	assert.equal(writeStdin.parameters.additionalProperties, false);
	assert.equal(writeStdin.parameters.properties.session_id.type, "integer");
	assert.match(writeStdin.description, /existing unified exec session/);
	assert.match(
		writeStdin.parameters.properties.chars.description,
		/all other non-empty input is rejected/,
	);
});

test("HTTP client names use normal execution instead of a retired tool guard", async () => {
	const execCommand = registeredTools().get("exec_command");
	assert.ok(execCommand);
	// These literal echoes reproduced false positives without making HTTP requests.
	for (const cmd of ["echo curl https://example.invalid", "echo Invoke-WebRequest", "echo urllib.request"]) {
		const result = await execCommand.execute(
			"client-name-test", { cmd, workdir: process.cwd(), login: false },
			undefined, undefined, { cwd: process.cwd() },
		);
		assert.equal(result.details.exit_code, 0);
		assert.equal(result.details.cmd, cmd);
		assert.doesNotMatch(result.content[0].text, /blocked by pi-codex-compat|context-mode/);
	}
	for (const tool of registeredTools().values()) {
		assert.doesNotMatch((tool.promptGuidelines ?? []).join("\n"), /context-mode|ctx_execute|ctx_fetch_and_index|fetch_content/);
	}
	assert.match(execCommand.promptGuidelines.join("\n"), /save the body to a file/);
	assert.match(execCommand.promptGuidelines.join("\n"), /read_artifact/);
});

test("exec_command uses the managed runtime and returns Unified Exec metadata", async () => {
	const execCommand = registeredTools().get("exec_command");
	assert.ok(execCommand);
	const cmd = `node -e "process.stdout.write('managed')"`;
	const result = await execCommand.execute(
		"managed-test",
		{ cmd, workdir: process.cwd(), login: false },
		undefined,
		undefined,
		{ cwd: process.cwd() },
	);
	assert.equal(result.details.running, false);
	assert.equal(result.details.exit_code, 0);
	assert.equal(result.details.cmd, cmd);
	assert.equal(result.details.tty, false);
	assert.match(result.details.chunk_id, /^[0-9a-f]{6}$/);
	assert.equal(typeof result.details.wall_time_seconds, "number");
	assert.equal(result.details.original_token_count, 2);
	assert.equal(result.details.output, "managed");
	assert.match(
		result.content[0].text,
		/^Chunk ID: [0-9a-f]{6}\nWall time: \d+\.\d{4} seconds\nProcess exited with code 0\nOriginal token count: 2\nOutput:\nmanaged$/,
	);
});

test("exec_command rejects tty:true instead of pretending pipes are a PTY", async () => {
	const execCommand = registeredTools().get("exec_command");
	await assert.rejects(
		execCommand.execute(
			"tty-test",
			{ cmd: "echo no", tty: true, workdir: process.cwd() },
			undefined,
			undefined,
			{ cwd: process.cwd() },
		),
		/plain pipes.*PTY\/ConPTY/,
	);
});

test("custom command renderers collapse successes and retain expanded or error output", () => {
	const tools = registeredTools();
	const theme = {
		fg: (_color, text) => text,
		bold: (text) => text,
	};
	const render = (component) => component.render(200).join("\n").trimEnd();
	const options = { expanded: false, isPartial: false };

	const execCommand = tools.get("exec_command");
	const execResult = {
		content: [{ type: "text", text: "full command output" }],
		details: { running: false, exit_code: 0 },
	};
	assert.equal(
		render(
			execCommand.renderResult(execResult, options, theme, {
				isError: false,
				lastComponent: undefined,
			}),
		),
		"✓ Completed",
	);
	assert.match(
		render(
			execCommand.renderResult(
				execResult,
				{ ...options, expanded: true },
				theme,
				{ isError: false, lastComponent: undefined },
			),
		),
		/full command output/,
	);
	assert.match(
		render(
			execCommand.renderResult(
				{ ...execResult, details: { running: false, error: "boom" } },
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
