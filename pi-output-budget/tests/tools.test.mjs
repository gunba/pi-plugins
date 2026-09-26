import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import extension, { readSnapshot, slimArchivedResults } from "../extensions/index.ts";
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

test("batch searches complete snapshots and reports errors without losing other files", async t => {
  const f = await fixture(t);
  await writeFile(join(f.cwd, "large.txt"), "early\n".repeat(30000) + "late needle\n");
  const result = await f.tools.get("inspect_files").execute("batch", { requests: [
    { path: "absent.txt" }, { path: "large.txt", query: "needle" },
  ] }, undefined, undefined, f.ctx);
  assert.equal(result.details.errors, 1);
  assert.match(result.content[0].text, /ERROR:/);
  assert.match(result.content[0].text, /30001: late needle/);
});

test("output middleware preserves errors, usage, native metadata and full-read overrides", async t => {
  const f = await fixture(t);
  const event = {
    toolName: "exec_command", content: [{ type: "text", text: "x".repeat(30000) }],
    details: { full_output_path: "/native/full.log" }, isError: true, usage: { input: 123 },
  };
  const result = await f.handlers.get("tool_result")(event, f.ctx);
  assert.equal(result.details.full_output_path, "/native/full.log");
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

test("MCP originals survive temporary-file removal and later replay compaction", async t => {
  const f = await fixture(t);
  const file = join(f.cwd, "mcp-output.txt");
  const original = "complete\n".repeat(10000) + "tail evidence";
  await writeFile(file, original);
  const result = await f.handlers.get("tool_result")({
    toolName: "mcp", content: [{ type: "text", text: "small upstream preview" }],
    details: { outputGuard: { truncated: true, fullOutputPath: file }, mcpResult: { content: [] } },
  }, f.ctx);
  await rm(file);
  assert.equal(await f.store.get(result.details.full_output_artifact), original);
  assert.equal(result.details.outputArtifact, result.details.full_output_artifact);
  const message = { role: "toolResult", toolCallId: "mcp-call", toolName: "mcp", isError: false, content: result.content, details: result.details };
  const slimmed = await slimArchivedResults([message], f.store, new Set(), new Set([`mcp-call\0${result.details.outputArtifact}`]));
  assert.match(slimmed[0].content[0].text, new RegExp(result.details.full_output_artifact));
  const read = await f.tools.get("read_artifact").execute("read", { artifact: result.details.outputArtifact, offset: original.length - 13 });
  assert.match(read.content[0].text, /tail evidence/);
});

test("MCP spill capture preserves images and does not trust paths in server payloads", async t => {
  const f = await fixture(t);
  const file = join(f.cwd, "mcp-image-caption.txt");
  await writeFile(file, "complete caption");
  const image = { type: "image", mimeType: "image/png", data: "native-image" };
  const captured = await f.handlers.get("tool_result")({
    toolName: "mcp", content: [{ type: "text", text: "caption preview" }, image],
    details: { outputGuard: { truncated: true, fullOutputPath: file } },
  }, f.ctx);
  assert.equal(captured.content[1], image);
  assert.equal(await f.store.get(captured.details.outputArtifact), "complete caption");
  assert.equal(await f.handlers.get("tool_result")({
    toolName: "mcp", content: [{ type: "text", text: "small result" }],
    details: { mcpResult: { omitted: true, fullResultPath: file, outputGuard: { truncated: true, fullOutputPath: file } } },
  }, f.ctx), undefined);
});

test("a missing MCP original is reported before the bounded preview", async t => {
  const f = await fixture(t);
  const result = await f.handlers.get("tool_result")({
    toolName: "mcp", content: [{ type: "text", text: "preview".repeat(5000) }],
    details: { outputGuard: { truncated: true, fullOutputPath: join(f.cwd, "missing.txt") } },
  }, f.ctx);
  assert.match(result.content[0].text.slice(0, 400), /preview is incomplete/);
  assert.equal(result.details.full_output_artifact, undefined);
});
