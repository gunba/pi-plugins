import assert from "node:assert/strict";
import test from "node:test";
import { PRESERVE_BUILTIN_BASH, isCodexLikeModel, isImageGenerationModel, syncCodexCompatTools, toolsForModel } from "../extensions/model-tools.ts";

const EMPTY = { enabled: false };
const AUTH = { imageGenerationAuthenticated: true };

test("provider matching stays exact while supporting current GPT model versions", () => {
	for (const id of ["gpt-5", "gpt-6-sol", "gpt-6.1-sol"])
		assert.equal(isCodexLikeModel({ provider: "openai", id }), true);
	assert.equal(isCodexLikeModel({ provider: "my-codex-proxy", id: "gpt-6.1-sol" }), false);
	assert.equal(isCodexLikeModel({ provider: "proxy", api: "openai-codex-responses", id: "model" }), true);
	assert.equal(isImageGenerationModel({ provider: "anthropic", id: "claude-opus-5.5" }), false);
	assert.equal(isImageGenerationModel({ provider: "github-copilot", id: "gpt-6-sol" }), false);
});

test("process control works across providers without suppressing native editing tools", () => {
	assert.equal(PRESERVE_BUILTIN_BASH, true);
	for (const model of [{ provider: "openai-codex", id: "gpt-6.1-sol" }, { provider: "anthropic", id: "claude-opus-5.5" }]) {
		const selected = syncCodexCompatTools(["read", "bash", "edit", "write", "custom", "exec_command", "write_stdin"], model, EMPTY);
		assert.deepEqual(selected.activeTools, ["read", "bash", "edit", "write", "custom", "exec_command", "write_stdin"]);
	}
	assert.deepEqual(toolsForModel(undefined), []);
});

test("image generation needs authentication and an eligible provider", () => {
	const text = { provider: "openai-codex", id: "gpt-6.1-sol", input: ["text"] };
	assert.deepEqual(toolsForModel(text), ["exec_command", "write_stdin"]);
	assert.deepEqual(toolsForModel(text, AUTH), ["exec_command", "write_stdin", "view_image", "image_gen"]);
	assert.deepEqual(toolsForModel({ provider: "anthropic", id: "claude", input: ["text", "image"] }, AUTH),
		["exec_command", "write_stdin", "view_image"]);
});

test("resynchronization respects manual tool choices and never widens an allowlist", () => {
	const model = { provider: "openai-codex", id: "gpt-6.1-sol", input: ["text", "image"] };
	assert.deepEqual(syncCodexCompatTools(["read", "edit"], model, EMPTY, AUTH).activeTools, ["read", "edit"]);
	const initial = syncCodexCompatTools(["read", "edit", "custom", "exec_command", "write_stdin", "view_image", "image_gen"], model, EMPTY, AUTH);
	const reduced = initial.activeTools.filter(name => !["custom", "view_image"].includes(name));
	const next = syncCodexCompatTools(reduced, model, initial.state, AUTH);
	assert.deepEqual(next.activeTools, reduced);
	const stable = syncCodexCompatTools(next.activeTools, model, next.state, AUTH);
	assert.deepEqual(stable, next);
});
