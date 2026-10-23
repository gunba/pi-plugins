import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import extension, { readSnapshot } from "../extensions/index.ts";
import { ArtifactStore } from "../extensions/artifacts.ts";

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-output-tools-"));
  const old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = cwd;
  t.after(async () => {
    if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old;
    await rm(cwd, { recursive: true, force: true });
  });
  const tools = new Map(), handlers = new Map();
  extension({ registerTool: tool => tools.set(tool.name, tool), on: (name, fn) => handlers.set(name, fn) });
  return { cwd, tools, handlers, ctx: { cwd, isProjectTrusted: () => false }, store: new ArtifactStore(join(cwd, "tool-output")) };
}

test("read archives the exact requested range, including huge first lines", async t => {
  const f = await fixture(t);
  const text = "skip\n" + "🙂".repeat(30000) + "\nlast\noutside";
  await writeFile(join(f.cwd, "large.txt"), text);
  const result = await readSnapshot("id", { path: "large.txt", offset: 2, limit: 2 }, undefined, f.ctx, f.store);
  assert.equal(await f.store.get(result.details.outputArtifact), "🙂".repeat(30000) + "\nlast");
  assert.match(result.content[0].text, /read offset=4/);
  assert.ok(result.content[0].text.length < 34000);
  const full = await readSnapshot("full", { path: "large.txt", full: true }, undefined, f.ctx, f.store);
  assert.equal(full.content[0].text, text);
});

test("output middleware preserves errors, usage, native metadata and full-read overrides", async t => {
  const f = await fixture(t);
  const event = {
    toolName: "web_search", content: [{ type: "text", text: "x".repeat(30000) }],
    details: { model: "openai-codex/search" }, isError: true, usage: { input: 123 },
  };
  const result = await f.handlers.get("tool_result")(event, f.ctx);
  assert.equal(result.details.model, "openai-codex/search");
  assert.equal(result.isError, undefined, "omitted patches preserve original isError");
  assert.equal(result.usage, undefined, "omitted patches preserve native nested usage");
  assert.equal(await f.store.get(result.details.outputArtifact), event.content[0].text);
  assert.equal(await f.handlers.get("tool_result")({ ...event, details: { outputBudgeted: true } }, f.ctx), undefined);
  assert.equal(await f.handlers.get("tool_result")({ ...event, content: [{ type: "image", data: "", mimeType: "image/png" }] }, f.ctx), undefined);
  const arrayMetadata = await f.handlers.get("tool_result")({ ...event, details: ["native", "array"] }, f.ctx);
  assert.equal(arrayMetadata.details, undefined, "non-record native details must not be reshaped");
});

test("cancelled file reads stop before returning evidence", async t => {
  const f = await fixture(t);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(readSnapshot("id", { path: "none" }, controller.signal, f.ctx, f.store), /abort/i);
});

test("Pi's own tools are cut where Pi cuts them, keeping its notice, and its spill file outlives Pi", async t => {
  const f = await fixture(t);
  const file = join(f.cwd, "bash-output.log");
  const original = "complete\n".repeat(10000) + "tail evidence";
  await writeFile(file, original);
  // Pi kept the end of the output and named its spill file; the result is cut to its end again.
  const kept = "line\n".repeat(10000) + "exit status 2";
  const notice = `\n\n[Showing lines 4001-10001 of 10001 (50.0KB limit). Full output: ${file}]`;
  const result = await f.handlers.get("tool_result")({
    toolName: "bash", content: [{ type: "text", text: kept + notice }], details: { fullOutputPath: file },
  }, f.ctx);
  await rm(file);
  const text = result.content[0].text;
  assert.ok(text.startsWith("…") && text.length < 16_200);
  assert.ok(text.includes(`exit status 2${notice}\n\n[Cut to its end, 16000 of ${(kept + notice).length} characters. Complete output: sha256-`));
  assert.equal(await f.store.get(result.details.full_output_artifact), original);
  const read = await f.tools.get("read_artifact").execute("read", { artifact: result.details.full_output_artifact, offset: original.length - 13 });
  assert.match(read.content[0].text, /tail evidence/);
  // grep keeps the start of its output; codemode and MCP tools the start and end.
  const long = "a".repeat(10000) + "b".repeat(10000) + "\n\n[100 matches limit reached]";
  const start = await f.handlers.get("tool_result")({ toolName: "grep", content: [{ type: "text", text: long }] }, f.ctx);
  assert.match(start.content[0].text, /^a+b+…\n\n\[100 matches limit reached\]\n\n\[Cut to its start, /);
  const both = await f.handlers.get("tool_result")({ toolName: "mcp__docs__search", content: [{ type: "text", text: long }] }, f.ctx);
  assert.match(both.content[0].text, /^a+…b+\n\n\[100 matches limit reached\]\n\n\[Cut to its start and end, /);
  assert.equal(await f.store.get(both.details.outputArtifact), long);
});

test("spill capture keeps images and follows only the spill path of Pi's own tools", async t => {
  const f = await fixture(t);
  const file = join(f.cwd, "mcp-image-caption.txt");
  await writeFile(file, "complete caption");
  const image = { type: "image", mimeType: "image/png", data: "native-image" };
  const captured = await f.handlers.get("tool_result")({
    toolName: "mcp__docs__render", content: [{ type: "text", text: "caption preview" }, image],
    details: { fullOutputPath: file },
  }, f.ctx);
  assert.equal(captured.content[1], image);
  assert.equal(await f.store.get(captured.details.full_output_artifact), "complete caption");
  for (const event of [
    { toolName: "mcp__docs__render", details: { structured: { fullOutputPath: file } } },
    { toolName: "web_search", details: { fullOutputPath: file } },
  ]) assert.equal(await f.handlers.get("tool_result")({ ...event, content: [{ type: "text", text: "small result" }] }, f.ctx), undefined);
});

test("a missing spill file is reported with the result", async t => {
  const f = await fixture(t);
  const result = await f.handlers.get("tool_result")({
    toolName: "bash", content: [{ type: "text", text: "end of the output" }],
    details: { fullOutputPath: join(f.cwd, "missing.log") },
  }, f.ctx);
  assert.equal(result.content[0].text, "end of the output");
  assert.match(result.content[1].text, /Could not archive the complete output/);
  assert.equal(result.details.full_output_artifact, undefined);
});
