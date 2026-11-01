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

test("other tools' long text becomes a short excerpt, with the whole of it in a file read can open", async t => {
  const f = await fixture(t);
  const text = lines(2500);
  const result = await f.budget({ toolName: "web_fetch", content: [{ type: "text", text }], details: { model: "parallel" }, isError: true, usage: { input: 1 } }, f.ctx);
  const path = f.store.path(result.details.outputArtifact);
  assert.equal(result.content[0].text, `[Output: 2,500 lines, 23.3KB. Below: its first 40 lines. The whole output: ${path} (read or grep it for more).]\n${lines(40)}`);
  assert.equal(await readFile(path, "utf8"), text);
  assert.equal(result.details.model, "parallel");
  assert.equal(result.isError, undefined, "omitted patches keep the original error flag");
  assert.equal(result.usage, undefined, "omitted patches keep native nested usage");
  // Long lines: as many whole lines as fit in 3,000 bytes, or the start of one.
  const wide = await f.budget({ toolName: "web_fetch", content: [{ type: "text", text: Array.from({ length: 100 }, () => "x".repeat(1000)).join("\n") }] }, f.ctx);
  assert.match(wide.content[0].text, /^\[Output: 100 lines, 97\.8KB\. Below: its first 2 lines\..*\]\nx{1000}\nx{1000}$/);
  const line = await f.budget({ toolName: "web_fetch", content: [{ type: "text", text: "y".repeat(60_000) }] }, f.ctx);
  assert.match(line.content[0].text, /^\[Output: 1 line, 58\.6KB\. Below: its first line\..*\]\ny{3000}$/);
});

test("short results, images, results already cut and non-record details are left alone or kept whole", async t => {
  const f = await fixture(t);
  assert.equal(await f.budget({ toolName: "web_fetch", content: [{ type: "text", text: lines(10) }] }, f.ctx), undefined);
  assert.equal(await f.budget({ toolName: "show", content: [{ type: "text", text: lines(3000) }, { type: "image", data: "", mimeType: "image/png" }] }, f.ctx), undefined);
  assert.equal(await f.budget({ toolName: "web_fetch", content: [{ type: "text", text: lines(3000) }], details: { outputBudgeted: true } }, f.ctx), undefined);
  const arrayDetails = await f.budget({ toolName: "web_fetch", content: [{ type: "text", text: lines(3000) }], details: ["native"] }, f.ctx);
  assert.equal(arrayDetails.details, undefined, "non-record native details must not be reshaped");
});

test("Pi's own tools: a spilled output becomes an excerpt of the saved whole; images and details stay", async t => {
  const f = await fixture(t);
  assert.equal(await f.budget({ toolName: "bash", content: [{ type: "text", text: lines(5000) }] }, f.ctx), undefined);
  assert.equal(await f.budget({ toolName: "mcp__docs__search", content: [{ type: "text", text: lines(5000) }] }, f.ctx), undefined);
  const file = join(f.cwd, "bash-output.log");
  await writeFile(file, lines(5000));
  const content = [{ type: "text", text: `tail\n\n[Showing lines 4001-5000 of 5000. Full output: ${file}]` }];
  const result = await f.budget({ toolName: "bash", content, details: { fullOutputPath: file, exitCode: 2 } }, f.ctx);
  const saved = f.store.path(result.details.full_output_artifact);
  assert.equal(result.content[0].text, `[Output: 5,000 lines, 47.7KB. Below: its last 40 lines. The whole output: ${saved} (read or grep it for more).]\n${lines(5000).split("\n").slice(-40).join("\n")}`);
  assert.equal(result.details.exitCode, 2);
  assert.equal(await f.store.get(result.details.full_output_artifact), lines(5000));
  // Other tools' outputs start with what matters; images are kept after the excerpt.
  const image = { type: "image", data: "", mimeType: "image/png" };
  const script = await f.budget({ toolName: "codemode", content: [{ type: "text", text: "cut" }, image], details: { fullOutputPath: file } }, f.ctx);
  assert.match(script.content[0].text, /^\[Output: 5,000 lines, .*Below: its first 40 lines\..*\]\nline 1\n/);
  assert.deepEqual(script.content[1], image);
  // A spill path from another tool's payload, or a missing spill file, is not followed.
  assert.equal(await f.budget({ toolName: "web_search", content: [{ type: "text", text: "small" }], details: { fullOutputPath: file } }, f.ctx), undefined);
  assert.equal(await f.budget({ toolName: "bash", content, details: { fullOutputPath: join(f.cwd, "missing.log") } }, f.ctx), undefined);
});
