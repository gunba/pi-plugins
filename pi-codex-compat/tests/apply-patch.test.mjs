import assert from "node:assert/strict";
import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
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

async function executePatch(cwd, input) {
	return registeredTools()
		.get("apply_patch")
		.execute("patch-test", { input }, undefined, undefined, { cwd });
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

test("exec_command-intercepted apply_patch uses the direct call and result renderer", async (t) => {
	const directCwd = await makeWorkspace(t);
	const execCwd = await makeWorkspace(t);
	await writeFile(join(directCwd, "value.txt"), "before\n");
	await writeFile(join(execCwd, "value.txt"), "before\n");
	const input = updatePatch("value.txt", "before", "after");
	const directArgs = { input };
	const execArgs = { cmd: `apply_patch <<'PATCH'\n${input}\nPATCH` };
	const tools = registeredTools();
	const applyPatch = tools.get("apply_patch");
	const execCommand = tools.get("exec_command");

	assert.equal(
		render(
			execCommand.renderCall(
				execArgs,
				identityTheme,
				renderContext(execCwd, execArgs),
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
	const execResult = await execCommand.execute(
		"exec-renderer",
		execArgs,
		undefined,
		undefined,
		{ cwd: execCwd },
	);
	assert.equal(await readFile(join(execCwd, "value.txt"), "utf8"), "after\n");

	for (const expanded of [false, true]) {
		const options = { expanded, isPartial: false };
		assert.equal(
			render(
				execCommand.renderResult(
					execResult,
					options,
					identityTheme,
					renderContext(execCwd, execArgs),
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
			execCommand.renderResult(
				execResult,
				{ expanded: true, isPartial: false },
				identityTheme,
				renderContext(execCwd, execArgs),
			),
		),
		/^\+1 after$/m,
	);
});

test("intercepted cd resolves relative to exec_command workdir", async (t) => {
	const cwd = await makeWorkspace(t);
	await mkdir(join(cwd, "repo", "sub"), { recursive: true });
	await mkdir(join(cwd, "sub"), { recursive: true });
	await writeFile(join(cwd, "repo", "sub", "value.txt"), "right\n");
	await writeFile(join(cwd, "sub", "value.txt"), "wrong\n");
	const input = updatePatch("value.txt", "right", "updated");
	const execCommand = registeredTools().get("exec_command");
	const result = await execCommand.execute(
		"nested-workdir",
		{
			cmd: `cd sub && apply_patch <<'PATCH'\n${input}\nPATCH`,
			workdir: "repo",
		},
		undefined,
		undefined,
		{ cwd },
	);
	assert.equal(result.details.exitCode, 0);
	assert.equal(
		await readFile(join(cwd, "repo", "sub", "value.txt"), "utf8"),
		"updated\n",
	);
	assert.equal(
		await readFile(join(cwd, "sub", "value.txt"), "utf8"),
		"wrong\n",
	);
});

test("direct wrapped input composes cd with apply_patch workdir", async (t) => {
	const cwd = await makeWorkspace(t);
	await mkdir(join(cwd, "repo", "sub"), { recursive: true });
	await writeFile(join(cwd, "repo", "value.txt"), "outer\n");
	await writeFile(join(cwd, "repo", "sub", "value.txt"), "inner\n");
	const input = updatePatch("value.txt", "inner", "updated");
	const applyPatch = registeredTools().get("apply_patch");
	const result = await applyPatch.execute(
		"direct-nested-workdir",
		{
			input: `cd sub && apply_patch <<'PATCH'\n${input}\nPATCH`,
			workdir: "repo",
		},
		undefined,
		undefined,
		{ cwd },
	);
	assert.equal(result.details.exitCode, 0);
	assert.equal(
		await readFile(join(cwd, "repo", "value.txt"), "utf8"),
		"outer\n",
	);
	assert.equal(
		await readFile(join(cwd, "repo", "sub", "value.txt"), "utf8"),
		"updated\n",
	);
});

test("intercepted quoted workdir whitespace is preserved as path content", async (t) => {
	const cwd = await makeWorkspace(t);
	await mkdir(join(cwd, " padded "), { recursive: true });
	await writeFile(join(cwd, " padded ", "value.txt"), "before\n");
	const execCommand = registeredTools().get("exec_command");
	const input = updatePatch("value.txt", "before", "after");
	const result = await execCommand.execute(
		"quoted-workdir",
		{
			cmd: `cd ' padded ' && apply_patch <<'PATCH'\n${input}\nPATCH`,
		},
		undefined,
		undefined,
		{ cwd },
	);
	assert.equal(result.details.exitCode, 0);
	assert.equal(
		await readFile(join(cwd, " padded ", "value.txt"), "utf8"),
		"after\n",
	);
});

test("apply_patch broadly handles add, delete, update, move, and Codex-shaped output", async (t) => {
	const cwd = await makeWorkspace(t);
	await writeFile(join(cwd, "delete.txt"), "remove me\n");
	await writeFile(join(cwd, "source.txt"), "before\n");
	const input = [
		"*** Begin Patch",
		"*** Add File: added.txt",
		"+added",
		"*** Delete File: delete.txt",
		"*** Update File: source.txt",
		"*** Move to: moved.txt",
		"@@",
		"-before",
		"+after",
		"*** End Patch",
	].join("\n");
	const result = await executePatch(cwd, input);

	assert.equal(await readFile(join(cwd, "added.txt"), "utf8"), "added\n");
	assert.equal(await readFile(join(cwd, "moved.txt"), "utf8"), "after\n");
	await assert.rejects(readFile(join(cwd, "delete.txt")), /ENOENT/);
	await assert.rejects(readFile(join(cwd, "source.txt")), /ENOENT/);
	assert.equal(result.details.exitCode, 0);
	assert.match(
		result.content[0].text,
		/^Exit code: 0\nWall time: \d+(?:\.\d+)? seconds\nOutput:\nSuccess\. Updated the following files:/,
	);
	assert.match(result.content[0].text, /^A added\.txt$/m);
	assert.match(result.content[0].text, /^M source\.txt$/m);
	assert.match(result.content[0].text, /^D delete\.txt$/m);
});

test("equal-position pure additions preserve patch order", async (t) => {
	const cwd = await makeWorkspace(t);
	await writeFile(join(cwd, "ordered.txt"), "start\n");
	const result = await executePatch(
		cwd,
		[
			"*** Begin Patch",
			"*** Update File: ordered.txt",
			"@@",
			"+first",
			"@@",
			"+second",
			"*** End Patch",
		].join("\n"),
	);
	assert.equal(result.details.exitCode, 0);
	assert.equal(
		await readFile(join(cwd, "ordered.txt"), "utf8"),
		"start\nfirst\nsecond\n",
	);
});

test("named-context pure additions follow Codex by appending at EOF", async (t) => {
	const cwd = await makeWorkspace(t);
	await writeFile(join(cwd, "anchored.txt"), "anchor\nafter\n");
	const result = await executePatch(
		cwd,
		[
			"*** Begin Patch",
			"*** Update File: anchored.txt",
			"@@ anchor",
			"+appended",
			"*** End Patch",
		].join("\n"),
	);
	assert.equal(result.details.exitCode, 0);
	assert.equal(
		await readFile(join(cwd, "anchored.txt"), "utf8"),
		"anchor\nafter\nappended\n",
	);
});

test("parser accepts CRLF, a missing final newline, empty adds, bare blank context, and EOF markers", async (t) => {
	const cwd = await makeWorkspace(t);
	await writeFile(join(cwd, "blank.txt"), "alpha\n\nomega\n");
	const patch = [
		"*** Begin Patch",
		"*** Add File: empty.txt",
		"*** Update File: blank.txt",
		"@@",
		" alpha",
		"",
		"-omega",
		"+final",
		"*** End of File",
		"*** End Patch",
	].join("\r\n");
	const result = await executePatch(cwd, patch);
	assert.equal(result.details.exitCode, 0);
	assert.equal(await readFile(join(cwd, "empty.txt"), "utf8"), "");
	assert.equal(
		await readFile(join(cwd, "blank.txt"), "utf8"),
		"alpha\n\nfinal\n",
	);
});

test("updates preserve a CRLF source file's line-ending style", async (t) => {
	const cwd = await makeWorkspace(t);
	await writeFile(join(cwd, "windows.txt"), "alpha\r\nbefore\r\nomega\r\n");
	const result = await executePatch(
		cwd,
		updatePatch("windows.txt", "before", "after"),
	);
	assert.equal(result.details.exitCode, 0);
	assert.equal(
		await readFile(join(cwd, "windows.txt"), "utf8"),
		"alpha\r\nafter\r\nomega\r\n",
	);
});

test("context matching uses all four tiers and prefers a later exact match", async (t) => {
	const cwd = await makeWorkspace(t);
	const cases = [
		["trailing.txt", "target   \n", "target", "trailing"],
		["trimmed.txt", "   target   \n", "target", "trimmed"],
		["unicode.txt", "smart—quote “value”\n", 'smart-quote "value"', "unicode"],
	];
	for (const [path, source, before, after] of cases) {
		await writeFile(join(cwd, path), source);
		const result = await executePatch(cwd, updatePatch(path, before, after));
		assert.equal(result.details.exitCode, 0, path);
		assert.equal(await readFile(join(cwd, path), "utf8"), `${after}\n`);
	}

	await writeFile(join(cwd, "exact.txt"), " target \ntarget\n");
	const result = await executePatch(
		cwd,
		updatePatch("exact.txt", "target", "changed"),
	);
	assert.equal(result.details.exitCode, 0);
	assert.equal(
		await readFile(join(cwd, "exact.txt"), "utf8"),
		" target \nchanged\n",
	);
});

test("parser rejects trailing junk, unsupported Environment ID, empty updates, and invalid move placement", async (t) => {
	const cwd = await makeWorkspace(t);
	await writeFile(join(cwd, "value.txt"), "value\n");
	const invalidPatches = [
		"<<EOF\n*** Begin Patch\n*** Add File: suffix.txt\n+bad\n*** End Patch\nNOTEOF",
		[
			"*** Begin Patch",
			"*** Add File: x.txt",
			"+x",
			"*** End Patch",
			"trailing",
		].join("\n"),
		[
			"*** Begin Patch",
			"*** Environment ID: remote",
			"*** Add File: x.txt",
			"+x",
			"*** End Patch",
		].join("\n"),
		["*** Begin Patch", "*** Update File: value.txt", "*** End Patch"].join(
			"\n",
		),
		[
			"*** Begin Patch",
			"*** Update File: value.txt",
			"@@",
			"-value",
			"+next",
			"*** Move to: later.txt",
			"*** End Patch",
		].join("\n"),
		[
			"*** Begin Patch",
			"*** Update File: value.txt",
			"*** Move to: one.txt",
			"*** Move to: two.txt",
			"@@",
			"-value",
			"+next",
			"*** End Patch",
		].join("\n"),
	];
	for (const input of invalidPatches) {
		const result = await executePatch(cwd, input);
		assert.equal(result.details.exitCode, 1);
		assert.equal(typeof result.details.error, "string");
		assert.match(result.content[0].text, /^Exit code: 1/m);
	}
	assert.equal(await readFile(join(cwd, "value.txt"), "utf8"), "value\n");
});

test("add and move overwrite destinations while same-path moves remain safe", async (t) => {
	const cwd = await makeWorkspace(t);
	await writeFile(join(cwd, "added.txt"), "old\n");
	await writeFile(join(cwd, "source.txt"), "source\n");
	await writeFile(join(cwd, "destination.txt"), "destination\n");
	let result = await executePatch(
		cwd,
		[
			"*** Begin Patch",
			"*** Add File: added.txt",
			"+new",
			"*** Update File: source.txt",
			"*** Move to: destination.txt",
			"@@",
			"-source",
			"+moved",
			"*** End Patch",
		].join("\n"),
	);
	assert.equal(result.details.exitCode, 0);
	assert.equal(await readFile(join(cwd, "added.txt"), "utf8"), "new\n");
	assert.equal(await readFile(join(cwd, "destination.txt"), "utf8"), "moved\n");
	assert.match(result.content[0].text, /^A added\.txt$/m);
	assert.match(result.content[0].text, /^M source\.txt$/m);
	await assert.rejects(readFile(join(cwd, "source.txt")), /ENOENT/);

	await writeFile(join(cwd, "same.txt"), "same\n");
	result = await executePatch(
		cwd,
		[
			"*** Begin Patch",
			"*** Update File: same.txt",
			"*** Move to: same.txt",
			"@@",
			"-same",
			"+safe",
			"*** End Patch",
		].join("\n"),
	);
	assert.equal(result.details.exitCode, 0);
	assert.equal(await readFile(join(cwd, "same.txt"), "utf8"), "safe\n");
});

test("a later filesystem failure rolls earlier writes back", async (t) => {
	const cwd = await makeWorkspace(t);
	await writeFile(join(cwd, "first.txt"), "original\n");
	await writeFile(join(cwd, "blocker"), "not a directory\n");
	const result = await executePatch(
		cwd,
		[
			"*** Begin Patch",
			"*** Update File: first.txt",
			"@@",
			"-original",
			"+changed",
			"*** Add File: blocker/child.txt",
			"+cannot be written",
			"*** End Patch",
		].join("\n"),
	);
	assert.equal(result.details.exitCode, 1);
	assert.equal(await readFile(join(cwd, "first.txt"), "utf8"), "original\n");
	assert.equal(
		await readFile(join(cwd, "blocker"), "utf8"),
		"not a directory\n",
	);
});

test("rollback removes directories created before a later write failure", async (t) => {
	const cwd = await makeWorkspace(t);
	const result = await executePatch(
		cwd,
		[
			"*** Begin Patch",
			"*** Add File: collision/child.txt",
			"+child",
			"*** Add File: collision",
			"+file",
			"*** End Patch",
		].join("\n"),
	);
	assert.equal(result.details.exitCode, 1);
	assert.match(result.details.error, /EISDIR|directory/i);
	assert.doesNotMatch(result.details.error, /rollback errors:/);
	await assert.rejects(stat(join(cwd, "collision")), /ENOENT/);
});
