import assert from "node:assert/strict";
import test from "node:test";

import {
	isCodexLikeModel,
	isImageGenerationModel,
	syncCodexCompatTools,
	toolsForModel,
} from "../extensions/model-tools.ts";

const EMPTY_STATE = { enabled: false, previousToolNames: [] };

test("Codex-like detection is conservative across providers and model ids", () => {
	assert.equal(isCodexLikeModel({ provider: "openai-codex", id: "gpt-5.6" }), true);
	assert.equal(isCodexLikeModel({ provider: "openai", id: "gpt-5" }), true);
	assert.equal(isCodexLikeModel({ provider: "github-copilot", id: "gpt-5" }), true);
	assert.equal(isCodexLikeModel({ provider: "anthropic", id: "claude-opus-4-6" }), false);
});

test("image tools are active for compatible OpenAI/Codex models, including text-only models", () => {
	assert.deepEqual(
		toolsForModel({ provider: "openai", id: "gpt-5", input: ["text"] }),
		["apply_patch", "shell_command", "write_stdin", "view_image", "image_gen"],
	);
	assert.deepEqual(
		toolsForModel({ provider: "openai", id: "gpt-5", input: ["text", "image"] }),
		["apply_patch", "shell_command", "write_stdin", "view_image", "image_gen"],
	);
	assert.deepEqual(
		toolsForModel({
			provider: "github-copilot",
			id: "gpt-5",
			input: ["text", "image"],
		}),
		["apply_patch", "shell_command", "write_stdin", "view_image"],
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

test("activation preserves unrelated tools and restores them after a model switch", () => {
	const enabled = syncCodexCompatTools(
		[
			"read",
			"bash",
			"custom_search",
			"apply_patch",
			"shell_command",
			"write_stdin",
			"view_image",
			"image_gen",
		],
		{ provider: "openai-codex", id: "gpt-5.6", input: ["text", "image"] },
		EMPTY_STATE,
	);
	assert.deepEqual(enabled.activeTools, [
		"read",
		"bash",
		"custom_search",
		"apply_patch",
		"shell_command",
		"write_stdin",
		"view_image",
		"image_gen",
	]);
	const resynced = syncCodexCompatTools(
		[...enabled.activeTools, "later_tool"],
		{ provider: "openai-codex", id: "gpt-5.6", input: ["text", "image"] },
		enabled.state,
	);
	assert.deepEqual(resynced.activeTools, [
		"read",
		"bash",
		"custom_search",
		"later_tool",
		"apply_patch",
		"shell_command",
		"write_stdin",
		"view_image",
		"image_gen",
	]);

	const disabled = syncCodexCompatTools(
		resynced.activeTools,
		{ provider: "anthropic", id: "claude-opus-4-6", input: ["text", "image"] },
		resynced.state,
	);
	assert.deepEqual(disabled.activeTools, ["read", "bash", "custom_search", "later_tool"]);
});

test("activation never widens an explicit active-tool allowlist", () => {
	const restricted = syncCodexCompatTools(
		["read", "bash"],
		{ provider: "openai-codex", id: "gpt-5.6", input: ["text", "image"] },
		EMPTY_STATE,
	);
	assert.deepEqual(restricted.activeTools, ["read", "bash"]);
});
