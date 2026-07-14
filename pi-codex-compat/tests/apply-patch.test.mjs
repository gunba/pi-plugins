import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";

import { initTheme } from "@earendil-works/pi-coding-agent";
import codexCompat from "../extensions/codex-compat.ts";

initTheme("dark", false);

const identityTheme = {
	fg: (_color, text) => text,
	bold: (text) => text,
};

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

function render(component) {
	return component
		.render(240)
		.map((line) => stripVTControlCharacters(line).trimEnd())
		.join("\n")
		.trimEnd();
}

function renderContext(cwd, args) {
	return { args, cwd, isError: false, lastComponent: undefined };
}

async function makeWorkspace(t) {
	const cwd = await mkdtemp(join(tmpdir(), "pi-codex-compat-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	return cwd;
}

function updatePatch(path, before, after) {
	return [
		"*** Begin Patch",
		`*** Update File: ${path}`,
		"@@",
		`-${before}`,
		`+${after}`,
		"*** End Patch",
	].join("\n");
}

test("direct apply_patch expanded rendering shows its effective diff", async (t) => {
	const cwd = await makeWorkspace(t);
	await writeFile(join(cwd, "notes.txt"), "alpha\nold\nomega\n");
	const input = [
		"*** Begin Patch",
		"*** Update File: notes.txt",
		"@@",
		" alpha",
		"-old",
		"+new",
		" omega",
		"*** End Patch",
	].join("\n");
	const args = { input };
	const applyPatch = registeredTools().get("apply_patch");

	const result = await applyPatch.execute(
		"direct-diff",
		args,
		undefined,
		undefined,
		{ cwd },
	);

	assert.equal(
		await readFile(join(cwd, "notes.txt"), "utf8"),
		"alpha\nnew\nomega\n",
	);
	assert.equal(result.details.changes.length, 1);
	assert.equal(
		result.details.changes[0].diff,
		" 1 alpha\n-2 old\n+2 new\n 3 omega",
	);
	assert.equal(
		render(
			applyPatch.renderResult(
				result,
				{ expanded: false, isPartial: false },
				identityTheme,
				renderContext(cwd, args),
			),
		),
		"✓ Patched 1 file",
	);
	const expanded = render(
		applyPatch.renderResult(
			result,
			{ expanded: true, isPartial: false },
			identityTheme,
			renderContext(cwd, args),
		),
	);
	assert.match(expanded, /^updated notes\.txt/m);
	assert.match(expanded, /^-2 old$/m);
	assert.match(expanded, /^\+2 new$/m);
	assert.doesNotMatch(expanded, /Applied patch\./);
});

test("apply_patch reports one original-to-final change and omits net no-ops", async (t) => {
	const cwd = await makeWorkspace(t);
	await writeFile(join(cwd, "changed.txt"), "original\n");
	await writeFile(join(cwd, "reverted.txt"), "stable\n");
	const input = [
		"*** Begin Patch",
		"*** Update File: changed.txt",
		"@@",
		"-original",
		"+intermediate",
		"*** Update File: changed.txt",
		"@@",
		"-intermediate",
		"+final",
		"*** Update File: reverted.txt",
		"@@",
		"-stable",
		"+temporary",
		"*** Update File: reverted.txt",
		"@@",
		"-temporary",
		"+stable",
		"*** End Patch",
	].join("\n");
	const args = { input };
	const applyPatch = registeredTools().get("apply_patch");

	const result = await applyPatch.execute(
		"effective-files",
		args,
		undefined,
		undefined,
		{ cwd },
	);

	assert.equal(await readFile(join(cwd, "changed.txt"), "utf8"), "final\n");
	assert.equal(await readFile(join(cwd, "reverted.txt"), "utf8"), "stable\n");
	assert.deepEqual(
		result.details.changes.map(({ action, path }) => ({ action, path })),
		[{ action: "updated", path: join(cwd, "changed.txt") }],
	);
	assert.match(result.details.changes[0].diff, /^-1 original$/m);
	assert.match(result.details.changes[0].diff, /^\+1 final$/m);
	assert.doesNotMatch(
		result.details.changes[0].diff,
		/intermediate|temporary|stable/,
	);
	assert.equal(
		render(
			applyPatch.renderResult(
				result,
				{ expanded: false, isPartial: false },
				identityTheme,
				renderContext(cwd, args),
			),
		),
		"✓ Patched 1 file",
	);
});

test("shell-intercepted apply_patch uses the direct call and result renderer", async (t) => {
	const directCwd = await makeWorkspace(t);
	const shellCwd = await makeWorkspace(t);
	await writeFile(join(directCwd, "value.txt"), "before\n");
	await writeFile(join(shellCwd, "value.txt"), "before\n");
	const input = updatePatch("value.txt", "before", "after");
	const directArgs = { input };
	const shellArgs = { command: `apply_patch <<'PATCH'\n${input}\nPATCH` };
	const tools = registeredTools();
	const applyPatch = tools.get("apply_patch");
	const shellCommand = tools.get("shell_command");

	assert.equal(
		render(
			shellCommand.renderCall(
				shellArgs,
				identityTheme,
				renderContext(shellCwd, shellArgs),
			),
		),
		render(
			applyPatch.renderCall(
				directArgs,
				identityTheme,
				renderContext(directCwd, directArgs),
			),
		),
	);

	const directResult = await applyPatch.execute(
		"direct-renderer",
		directArgs,
		undefined,
		undefined,
		{ cwd: directCwd },
	);
	const shellResult = await shellCommand.execute(
		"shell-renderer",
		shellArgs,
		undefined,
		undefined,
		{ cwd: shellCwd },
	);
	assert.equal(await readFile(join(shellCwd, "value.txt"), "utf8"), "after\n");

	for (const expanded of [false, true]) {
		const options = { expanded, isPartial: false };
		assert.equal(
			render(
				shellCommand.renderResult(
					shellResult,
					options,
					identityTheme,
					renderContext(shellCwd, shellArgs),
				),
			),
			render(
				applyPatch.renderResult(
					directResult,
					options,
					identityTheme,
					renderContext(directCwd, directArgs),
				),
			),
		);
	}
	assert.match(
		render(
			shellCommand.renderResult(
				shellResult,
				{ expanded: true, isPartial: false },
				identityTheme,
				renderContext(shellCwd, shellArgs),
			),
		),
		/^\+1 after$/m,
	);
});
