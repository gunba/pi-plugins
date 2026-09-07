import assert from "node:assert/strict";
import test from "node:test";

import {
	PREFER_APPLY_PATCH_OVER_EDIT,
	PRESERVE_BUILTIN_BASH,
	isCodexLikeModel,
	isImageGenerationModel,
	syncCodexCompatTools,
	toolsForModel,
} from "../extensions/model-tools.ts";

const EMPTY_STATE = { enabled: false };
const AUTHENTICATED = { imageGenerationAuthenticated: true };

test("Codex-like detection uses exact provider/API evidence instead of substring matches", () => {
	assert.equal(
		isCodexLikeModel({ provider: "openai-codex", id: "gpt-5.6" }),
		true,
	);
	assert.equal(isCodexLikeModel({ provider: "openai", id: "gpt-5" }), true);
	assert.equal(
		isCodexLikeModel({ provider: "github-copilot", id: "gpt-5" }),
		true,
	);
	assert.equal(isCodexLikeModel({ provider: "openai", id: "gpt-4o" }), false);
	assert.equal(
		isCodexLikeModel({ provider: "github-copilot", id: "gpt-4.1" }),
		false,
	);
	assert.equal(
		isCodexLikeModel({
			provider: "proxy",
			api: "openai-codex-responses",
			id: "model",
		}),
		true,
	);
	assert.equal(
		isCodexLikeModel({ provider: "my-codex-proxy", id: "gpt-5" }),
		false,
	);
	assert.equal(
		isCodexLikeModel({ provider: "openai-compatible", id: "gpt-5" }),
		false,
	);
	assert.equal(
		isCodexLikeModel({ provider: "anthropic", id: "claude-opus-4-6" }),
		false,
	);
	assert.equal(
		isImageGenerationModel({
			provider: "proxy",
			api: "openai-codex-responses",
			id: "model",
		}),
		false,
	);
});

test("image activation requires configured auth while retaining the text-only Pi adaptation", () => {
	const textOnly = { provider: "openai", id: "gpt-5", input: ["text"] };
	assert.deepEqual(toolsForModel(textOnly), [
		"apply_patch",
		"exec_command",
		"write_stdin",
	]);
	assert.deepEqual(toolsForModel(textOnly, AUTHENTICATED), [
		"apply_patch",
		"exec_command",
		"write_stdin",
		"view_image",
		"image_gen",
	]);
	assert.deepEqual(
		toolsForModel(
			{ provider: "openai", id: "gpt-5", input: ["text", "image"] },
			{ imageGenerationAuthenticated: false },
		),
		["apply_patch", "exec_command", "write_stdin", "view_image"],
	);
	assert.deepEqual(
		toolsForModel(
			{
				provider: "github-copilot",
				id: "gpt-5",
				input: ["text", "image"],
			},
			AUTHENTICATED,
		),
		["apply_patch", "exec_command", "write_stdin", "view_image"],
	);
	assert.equal(
		isImageGenerationModel({
			provider: "anthropic",
			id: "claude-opus-4-6",
			api: "openai-codex-responses",
			input: ["text", "image"],
		}),
		false,
	);
});

test("activation preserves unrelated tools, keeps bash, and prefers apply_patch over edit", () => {
	assert.equal(PRESERVE_BUILTIN_BASH, true);
	assert.equal(PREFER_APPLY_PATCH_OVER_EDIT, true);
	const enabled = syncCodexCompatTools(
		[
			"read",
			"bash",
			"edit",
			"custom_search",
			"apply_patch",
			"exec_command",
			"write_stdin",
			"view_image",
			"image_gen",
		],
		{ provider: "openai-codex", id: "gpt-5.6", input: ["text", "image"] },
		EMPTY_STATE,
		AUTHENTICATED,
	);
	assert.deepEqual(enabled.activeTools, [
		"read",
		"bash",
		"custom_search",
		"apply_patch",
		"exec_command",
		"write_stdin",
		"view_image",
		"image_gen",
	]);

	const disabled = syncCodexCompatTools(
		enabled.activeTools,
		{ provider: "anthropic", id: "claude-opus-4-6", input: ["text", "image"] },
		enabled.state,
		AUTHENTICATED,
	);
	assert.deepEqual(disabled.activeTools, [
		"read",
		"bash",
		"custom_search",
		"edit",
	]);
});

test("resynchronization never resurrects manually disabled base or compatibility tools", () => {
	const enabled = syncCodexCompatTools(
		[
			"read",
			"bash",
			"edit",
			"custom_search",
			"apply_patch",
			"exec_command",
			"write_stdin",
			"view_image",
			"image_gen",
		],
		{ provider: "openai", id: "gpt-5", input: ["text", "image"] },
		EMPTY_STATE,
		AUTHENTICATED,
	);
	const manuallyReduced = enabled.activeTools.filter(
		(name) => name !== "custom_search" && name !== "view_image",
	);
	const resynced = syncCodexCompatTools(
		manuallyReduced,
		{ provider: "openai", id: "gpt-5", input: ["text", "image"] },
		enabled.state,
		AUTHENTICATED,
	);
	assert.deepEqual(resynced.activeTools, [
		"read",
		"bash",
		"apply_patch",
		"exec_command",
		"write_stdin",
		"image_gen",
	]);

	const stable = syncCodexCompatTools(
		resynced.activeTools,
		{ provider: "openai", id: "gpt-5", input: ["text", "image"] },
		resynced.state,
		AUTHENTICATED,
	);
	assert.deepEqual(stable.activeTools, resynced.activeTools);
	assert.deepEqual(stable.state, resynced.state);

	const away = syncCodexCompatTools(
		stable.activeTools,
		{ provider: "anthropic", id: "claude-opus-4-6" },
		stable.state,
		AUTHENTICATED,
	);
	const back = syncCodexCompatTools(
		away.activeTools,
		{ provider: "openai", id: "gpt-5", input: ["text", "image"] },
		away.state,
		AUTHENTICATED,
	);
	assert.equal(back.activeTools.includes("custom_search"), false);
	assert.equal(back.activeTools.includes("view_image"), false);
	assert.equal(away.activeTools.includes("edit"), true);
	assert.equal(back.activeTools.includes("edit"), false);
});

test("activation never widens an explicit active-tool allowlist", () => {
	const restricted = syncCodexCompatTools(
		["read", "bash"],
		{ provider: "openai-codex", id: "gpt-5.6", input: ["text", "image"] },
		EMPTY_STATE,
		AUTHENTICATED,
	);
	assert.deepEqual(restricted.activeTools, ["read", "bash"]);

	const editOnly = syncCodexCompatTools(
		["read", "edit"],
		{ provider: "openai-codex", id: "gpt-5.6" },
		EMPTY_STATE,
	);
	assert.deepEqual(editOnly.activeTools, ["read", "edit"]);
});

test("disabling apply_patch restores edit and re-enabling it suppresses edit again", () => {
	const enabled = syncCodexCompatTools(
		["read", "edit", "apply_patch", "exec_command", "write_stdin"],
		{ provider: "openai-codex", id: "gpt-5.6" },
		EMPTY_STATE,
	);
	assert.equal(enabled.activeTools.includes("edit"), false);

	const applyPatchDisabled = syncCodexCompatTools(
		enabled.activeTools.filter((name) => name !== "apply_patch"),
		{ provider: "openai-codex", id: "gpt-5.6" },
		enabled.state,
	);
	assert.equal(applyPatchDisabled.activeTools.includes("apply_patch"), false);
	assert.equal(applyPatchDisabled.activeTools.includes("edit"), true);

	const applyPatchRestored = syncCodexCompatTools(
		[...applyPatchDisabled.activeTools, "apply_patch"],
		{ provider: "openai-codex", id: "gpt-5.6" },
		applyPatchDisabled.state,
	);
	assert.equal(applyPatchRestored.activeTools.includes("apply_patch"), true);
	assert.equal(applyPatchRestored.activeTools.includes("edit"), false);
});
