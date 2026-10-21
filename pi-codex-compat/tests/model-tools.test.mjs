import assert from "node:assert/strict";
import test from "node:test";
import { PRESERVE_BUILTIN_BASH, imageGenerationService, isCodexLikeModel, isImageGenerationModel, syncCodexCompatTools, toolsForModel } from "../extensions/model-tools.ts";

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

test("every model has the same tools: a model switch neither adds nor removes the process tools", () => {
	assert.equal(PRESERVE_BUILTIN_BASH, true);
	const codexModel = { provider: "openai-codex", id: "gpt-6.1-sol" }, claudeModel = { provider: "anthropic", id: "claude-opus-5.5" };
	assert.deepEqual(syncCodexCompatTools(["read", "bash", "edit", "write"], codexModel, EMPTY).activeTools, ["read", "bash", "edit", "write"]);
	const loaded = ["read", "bash", "edit", "write", "custom", "exec_command", "write_stdin"];
	const claude = syncCodexCompatTools(loaded, claudeModel, EMPTY);
	assert.deepEqual(claude.activeTools, loaded);
	assert.deepEqual(syncCodexCompatTools(claude.activeTools, codexModel, claude.state).activeTools, loaded);
	assert.deepEqual(toolsForModel(undefined), []);
});

test("image generation needs a signed-in image service, whatever model the conversation uses", () => {
	const text = { provider: "openai-codex", id: "gpt-6.1-sol", input: ["text"] };
	assert.deepEqual(toolsForModel(text), []);
	// image_gen itself is loaded with tool_search, so the model switch never adds or removes it.
	assert.deepEqual(toolsForModel(text, AUTH), ["view_image"]);
	const claude = { provider: "anthropic", id: "claude", input: ["text", "image"] };
	assert.deepEqual(toolsForModel(claude), ["view_image"]);
	assert.deepEqual(toolsForModel(claude, AUTH), ["view_image"]);
	// A Claude conversation uses a signed-in Codex account, before an OpenAI API one; Copilot never generates images.
	const openai = { provider: "openai", id: "gpt-6.1-sol" }, copilot = { provider: "github-copilot", id: "gpt-6-sol" };
	assert.equal(imageGenerationService(claude, [claude, copilot, openai, text]), text);
	assert.equal(imageGenerationService(claude, [claude, openai]), openai);
	assert.equal(imageGenerationService(claude, [claude, copilot]), undefined);
	assert.equal(imageGenerationService(openai, [text]), openai, "the conversation's own model comes first");
});

test("resynchronization respects manual tool choices and never widens an allowlist", () => {
	const model = { provider: "openai-codex", id: "gpt-6.1-sol", input: ["text", "image"] };
	// Nothing is added that was not already active.
	assert.deepEqual(syncCodexCompatTools(["read", "edit"], model, EMPTY, AUTH).activeTools, ["read", "edit"]);
	const initial = syncCodexCompatTools(["read", "edit", "custom", "exec_command", "write_stdin", "view_image"], model, EMPTY, AUTH);
	const reduced = initial.activeTools.filter(name => !["custom", "view_image"].includes(name));
	const next = syncCodexCompatTools(reduced, model, initial.state, AUTH);
	assert.deepEqual(next.activeTools, reduced);
	const stable = syncCodexCompatTools(next.activeTools, model, next.state, AUTH);
	assert.deepEqual(stable, next);
});
