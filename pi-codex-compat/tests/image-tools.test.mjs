import assert from "node:assert/strict";
import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";

import { initTheme } from "@earendil-works/pi-coding-agent";
import codexCompat from "../extensions/codex-compat.ts";
import { MAX_LOCAL_IMAGE_BYTES } from "../extensions/image-limits.ts";

initTheme("dark", false);

const PNG_DATA =
	"iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==";
const theme = {
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
		.render(200)
		.map((line) => stripVTControlCharacters(line).trimEnd())
		.join("\n")
		.trimEnd();
}

async function withTempDir(t) {
	const path = await mkdtemp(join(tmpdir(), "pi-codex-image-tools-"));
	t.after(() => rm(path, { recursive: true, force: true }));
	return path;
}

test("every owned tool publishes a strict top-level schema", () => {
	const tools = registeredTools();
	assert.deepEqual([...tools.keys()].sort(), [
		"apply_patch",
		"exec_command",
		"image_gen",
		"view_image",
		"write_stdin",
	]);
	for (const tool of tools.values()) {
		assert.equal(tool.parameters.additionalProperties, false, tool.name);
	}
});

test("image tool metadata carries upstream direct-generation and editing guidance", () => {
	const tools = registeredTools();
	const applyPatch = tools.get("apply_patch");
	const viewImage = tools.get("view_image");
	const imageGen = tools.get("image_gen");
	assert.doesNotMatch(
		[
			applyPatch.description,
			applyPatch.promptSnippet,
			...applyPatch.promptGuidelines,
		].join("\n"),
		/Environment ID/,
	);
	assert.equal(
		viewImage.description,
		"View a local image file from the filesystem when visual inspection is needed. Use this for images already available on disk.",
	);
	assert.match(
		imageGen.promptGuidelines.join("\n"),
		/Directly generate the image without reconfirmation or clarification/,
	);
	assert.match(
		imageGen.promptGuidelines.join("\n"),
		/Always use image_gen for image editing.*Do not use Python/s,
	);
});

test("view_image returns native image content and semantic rendering", async (t) => {
	const cwd = await withTempDir(t);
	const path = join(cwd, "tiny.png");
	await writeFile(path, Buffer.from(PNG_DATA, "base64"));
	const viewImage = registeredTools().get("view_image");
	const args = { path: "tiny.png" };
	const result = await viewImage.execute(
		"view-success",
		args,
		undefined,
		undefined,
		{ cwd, model: { input: ["text", "image"] } },
	);

	assert.equal(result.details.path, path);
	assert.equal(result.details.mediaType, "image/png");
	assert.equal(result.content[1].type, "image");
	assert.equal(result.content[1].data, PNG_DATA);
	assert.equal(
		render(
			viewImage.renderResult(
				result,
				{ expanded: false, isPartial: false },
				theme,
				{ args, cwd, isError: false, lastComponent: undefined },
			),
		),
		"• Viewed Image\n  tiny.png",
	);
});

test("view_image failures retain reusable details for lifecycle error shaping", async (t) => {
	const cwd = await withTempDir(t);
	const viewImage = registeredTools().get("view_image");
	const result = await viewImage.execute(
		"view-failure",
		{ path: "unsupported.txt" },
		undefined,
		undefined,
		{ cwd, model: { input: ["text", "image"] } },
	);

	assert.equal("isError" in result, false);
	assert.equal(result.details.path, join(cwd, "unsupported.txt"));
	assert.equal(result.details.mediaType, "application/octet-stream");
	assert.match(result.details.error, /unsupported image extension/);
	assert.match(
		render(
			viewImage.renderResult(
				result,
				{ expanded: false, isPartial: false },
				theme,
				{
					args: { path: "unsupported.txt" },
					cwd,
					isError: true,
					lastComponent: undefined,
				},
			),
		),
		/view_image failed/,
	);
});

test("view_image shapes missing, invalid, and oversized image failures", async (t) => {
	const cwd = await withTempDir(t);
	const invalidPath = join(cwd, "invalid.png");
	await writeFile(invalidPath, "not an image");
	const oversizedPath = join(cwd, "oversized.png");
	await writeFile(oversizedPath, "x");
	await truncate(oversizedPath, MAX_LOCAL_IMAGE_BYTES + 1);
	const viewImage = registeredTools().get("view_image");
	for (const [path, expected] of [
		["missing.png", /ENOENT/],
		["invalid.png", /unsupported or invalid image data/],
		["oversized.png", new RegExp(`larger than ${MAX_LOCAL_IMAGE_BYTES} bytes`)],
	]) {
		const result = await viewImage.execute(
			`view-${path}`,
			{ path },
			undefined,
			undefined,
			{ cwd, model: { input: ["text", "image"] } },
		);
		assert.equal("isError" in result, false);
		assert.equal(result.details.path, join(cwd, path));
		assert.equal(result.details.mediaType, "image/png");
		assert.match(result.details.error, expected);
	}
});

test("image_gen uses semantic call and saved-path result rendering", () => {
	const imageGen = registeredTools().get("image_gen");
	const cwd = "/workspace";
	const args = {
		prompt: "add a red hat",
		referenced_image_paths: ["person.png"],
	};
	assert.equal(
		render(
			imageGen.renderCall(args, theme, {
				args,
				cwd,
				isError: false,
				lastComponent: undefined,
			}),
		),
		"Edit Image: add a red hat",
	);
	assert.equal(
		render(
			imageGen.renderCall({}, theme, {
				args: {},
				cwd,
				isError: false,
				lastComponent: undefined,
			}),
		),
		"Generate Image",
	);
	const result = {
		content: [{ type: "text", text: "Saved generated image" }],
		details: {
			path: "/workspace/generated/result.png",
			operation: "edits",
			bytes: 100,
			callId: "call-1",
			revisedPrompt: "person wearing a red hat",
		},
	};
	assert.equal(
		render(
			imageGen.renderResult(
				result,
				{ expanded: true, isPartial: false },
				theme,
				{ args, cwd, isError: false, lastComponent: undefined },
			),
		),
		"• Generated Image:\n  generated/result.png\nRevised prompt: person wearing a red hat",
	);
});
