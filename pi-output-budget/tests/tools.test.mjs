import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import extension, { readTool } from "../extensions/index.ts";
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
  // The budget hook is the last tool_result handler registered.
  return { cwd, tools, budget: handlers.get("tool_result"), ctx: { cwd, isProjectTrusted: () => false }, store: new ArtifactStore(join(cwd, "tool-output")) };
}
const lines = count => Array.from({ length: count }, (_, i) => `line ${i + 1}`).join("\n");

test("read is Pi's read: 2000 lines, then an offset to continue, and a plain answer past the end", async t => {
  const f = await fixture(t);
  await writeFile(join(f.cwd, "long.txt"), lines(2500));
  const read = f.tools.get("read");
  const result = await read.execute("id", { path: "long.txt" }, undefined, undefined, f.ctx);
  assert.match(result.content[0].text, /line 2000\n\n\[Showing lines 1-2000 of 2500\. Use offset=2001 to continue\.\]$/);
  assert.deepEqual(Object.keys(read.parameters.properties).sort(), ["limit", "offset", "path"]);
  const past = await read.execute("id", { path: "long.txt", offset: 3000 }, undefined, undefined, f.ctx);
  assert.equal(past.content[0].text, "[The file has 2500 lines; offset 3000 is past the end. Nothing more to read.]");
});

test("cancelled reads stop", async t => {
  const f = await fixture(t);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(readTool().execute("id", { path: "none" }, controller.signal, undefined, f.ctx), /abort/i);
});

test("other tools' long text is cut like Pi's read, with the full text in a file read can open", async t => {
  const f = await fixture(t);
  const text = lines(2500);
  const result = await f.budget({ toolName: "web_fetch", content: [{ type: "text", text }], details: { model: "parallel" }, isError: true, usage: { input: 1 } }, f.ctx);
  const path = f.store.path(result.details.outputArtifact);
  assert.equal(result.content[0].text, `${lines(2000)}\n\n[Showing lines 1-2000 of 2500. Full output: ${path}; read it with offset=2001 to continue.]`);
  assert.equal(await readFile(path, "utf8"), text);
  assert.equal(result.details.model, "parallel");
  assert.equal(result.isError, undefined, "omitted patches keep the original error flag");
  assert.equal(result.usage, undefined, "omitted patches keep native nested usage");
  // 50 KB comes first when lines are long.
  const wide = await f.budget({ toolName: "web_fetch", content: [{ type: "text", text: Array.from({ length: 100 }, () => "x".repeat(1000)).join("\n") }] }, f.ctx);
  assert.match(wide.content[0].text, /\n\n\[Showing lines 1-51 of 100 \(50\.0KB limit\)\. Full output: .+; read it with offset=52 to continue\.\]$/);
  // One line over the limit: its start, and the file.
  const line = await f.budget({ toolName: "web_fetch", content: [{ type: "text", text: "y".repeat(60_000) }] }, f.ctx);
  assert.match(line.content[0].text, /^y{51200}\n\n\[Line 1 is 58\.6KB, over the 50\.0KB limit; this is its start\. Full output: /);
});

test("short results, images, results already cut and non-record details are left alone or kept whole", async t => {
  const f = await fixture(t);
  assert.equal(await f.budget({ toolName: "web_fetch", content: [{ type: "text", text: lines(10) }] }, f.ctx), undefined);
  assert.equal(await f.budget({ toolName: "show", content: [{ type: "text", text: lines(3000) }, { type: "image", data: "", mimeType: "image/png" }] }, f.ctx), undefined);
  assert.equal(await f.budget({ toolName: "web_fetch", content: [{ type: "text", text: lines(3000) }], details: { outputBudgeted: true } }, f.ctx), undefined);
  const arrayDetails = await f.budget({ toolName: "web_fetch", content: [{ type: "text", text: lines(3000) }], details: ["native"] }, f.ctx);
  assert.equal(arrayDetails.details, undefined, "non-record native details must not be reshaped");
});

test("Pi's own tools keep Pi's result; only its spill file is copied, for Desk", async t => {
  const f = await fixture(t);
  assert.equal(await f.budget({ toolName: "bash", content: [{ type: "text", text: lines(5000) }] }, f.ctx), undefined);
  assert.equal(await f.budget({ toolName: "mcp__docs__search", content: [{ type: "text", text: lines(5000) }] }, f.ctx), undefined);
  const file = join(f.cwd, "bash-output.log");
  await writeFile(file, "complete output");
  const content = [{ type: "text", text: `tail\n\n[Showing lines 4001-5000 of 5000. Full output: ${file}]` }];
  const result = await f.budget({ toolName: "bash", content, details: { fullOutputPath: file, exitCode: 2 } }, f.ctx);
  assert.equal(result.content, undefined);
  assert.equal(result.details.exitCode, 2);
  assert.equal(await f.store.get(result.details.full_output_artifact), "complete output");
  // A spill path from another tool's payload, or a missing spill file, is not followed.
  assert.equal(await f.budget({ toolName: "web_search", content: [{ type: "text", text: "small" }], details: { fullOutputPath: file } }, f.ctx), undefined);
  assert.equal(await f.budget({ toolName: "bash", content, details: { fullOutputPath: join(f.cwd, "missing.log") } }, f.ctx), undefined);
});
