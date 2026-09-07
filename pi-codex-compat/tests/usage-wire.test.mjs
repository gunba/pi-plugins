import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "pi-usage-wire-"));
process.env.PI_CODEX_USAGE_DIR = directory;
const { default: usage } = await import("../extensions/usage.ts");

test("wire counters update the footer and saved 7d snapshot; shutdown unsubscribes", async t => {
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const handlers = new Map();
  const listeners = new Map();
  let status;
  const ctx = {
    model: { api: "openai-codex-responses", id: "gpt-6-astra", provider: "openai-codex" },
    ui: { setStatus: (_key, value) => { status = value; }, theme: { fg: (_color, text) => text } },
  };
  usage({
    on: (name, handler) => handlers.set(name, handler),
    registerCommand() {},
    events: { on: (name, handler) => {
      listeners.set(name, handler);
      return () => listeners.delete(name);
    } },
  });
  t.after(() => handlers.get("session_shutdown")({}, ctx));
  await handlers.get("session_start")({}, ctx);
  const update = listeners.get("pi-codex-wire:allowance");
  update({
    "x-codex-primary-used-percent": 20, "x-codex-primary-window-minutes": 300,
    "x-codex-secondary-used-percent": 91, "x-codex-secondary-window-minutes": 10080,
  });
  assert.match(status, /5h:80%.*7d:9%/);
  update({ "x-codex-primary-used-percent": 95, "x-codex-primary-window-minutes": 10080 });
  assert.match(status, /7d:5%/);
  assert.doesNotMatch(status, /5h:/);
  const snapshot = JSON.parse(readFileSync(join(directory, "usage.json"), "utf8")).codex;
  assert.equal(snapshot.primary.usedPercent, 95);
  assert.equal(snapshot.primary.label, "7d");
  await handlers.get("session_shutdown")({}, ctx);
  assert.equal(listeners.size, 0);
  assert.equal(status, undefined);
});
