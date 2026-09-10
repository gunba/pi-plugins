import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createEventBus, DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { ensureWorkCoordination } from "../index.ts";

async function load(t, factories, eventBus = createEventBus()) {
  const directory = mkdtempSync(join(tmpdir(), "pi-work-loading-"));
  const loader = new DefaultResourceLoader({
    cwd: directory, agentDir: directory, eventBus,
    settingsManager: SettingsManager.inMemory(),
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: factories,
  });
  await loader.reload();
  const result = loader.getExtensions();
  t.after(() => { result.runtime.invalidate(); rmSync(directory, { recursive: true, force: true }); });
  return result;
}

function countTools(result) {
  const names = result.extensions.flatMap((extension) => [...extension.tools.keys()]);
  assert.equal(names.filter((name) => name === "wait_for_work").length, 1);
  assert.equal(names.filter((name) => name === "cancel_work_wait").length, 1);
}

test("real loader deduplicates distinct ExtensionAPI event facades on one underlying bus", async (t) => {
  const facades = [];
  const result = await load(t, ["scheduler", "goal", "subagents"].map((name) => ({ name, factory(pi) {
    facades.push(pi.events);
    ensureWorkCoordination(pi);
    ensureWorkCoordination(pi);
  } })));
  assert.equal(new Set(facades).size, 3, "the host uses distinct event facade objects");
  assert.deepEqual(result.errors, []);
  countTools(result);
  assert.equal(result.extensions.filter((extension) => extension.handlers.has("session_start")).length, 1);
});

test("standalone root and SDK child loaders each install their own policy", async (t) => {
  for (const child of [false, true]) {
    const result = await load(t, [{ name: child ? "child" : "root", factory: (pi) => ensureWorkCoordination(pi, { child }) }]);
    assert.deepEqual(result.errors, []); countTools(result);
  }
});

test("host invalidation releases discovery claim before replacement on the same bus", async (t) => {
  const bus = createEventBus();
  const first = await load(t, [ensureWorkCoordination], bus);
  assert.deepEqual(first.errors, []); countTools(first);
  first.runtime.invalidate();
  const second = await load(t, [ensureWorkCoordination], bus);
  assert.deepEqual(second.errors, []); countTools(second);
});

test("a failed factory cannot retain the shared claim and suppress a later working extension", async (t) => {
  const result = await load(t, [
    { name: "failed", factory(pi) { ensureWorkCoordination(pi); throw Error("fixture factory failure"); } },
    { name: "working", factory: ensureWorkCoordination },
  ]);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].error, /fixture factory failure/);
  countTools(result);
});
