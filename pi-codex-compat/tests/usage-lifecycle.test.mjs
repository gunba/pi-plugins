import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createEventBus, DefaultResourceLoader, ExtensionRunner, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

const headers = { "x-codex-primary-used-percent": "20", "x-codex-primary-window-minutes": "300", "x-codex-primary-reset-after-seconds": "3600" };
const stateKey = Symbol.for("pi.codexCompat.usage.state");

async function harness(t) {
  const directory = mkdtempSync(join(tmpdir(), "pi-usage-lifecycle-"));
  const oldDir = process.env.PI_CODEX_USAGE_DIR, oldStatus = process.env.PI_CODEX_USAGE_STATUS;
  const oldWebSocket = globalThis.WebSocket, oldState = globalThis[stateKey];
  process.env.PI_CODEX_USAGE_DIR = directory;
  process.env.PI_CODEX_USAGE_STATUS = "on";
  delete globalThis[stateKey];
  const { default: usage } = await import(`../extensions/usage.ts?lifecycle=${encodeURIComponent(directory)}`);
  const timers = new Map();
  t.mock.method(globalThis, "setInterval", callback => {
    const handle = { unref() {} }; timers.set(handle, callback); return handle;
  });
  t.mock.method(globalThis, "clearInterval", handle => { timers.delete(handle); });
  const bus = createEventBus(), runners = [];
  t.after(async () => {
    for (const runner of runners) {
      await runner.emit({ type: "session_shutdown", reason: "exit" });
      runner.invalidate();
    }
    globalThis.WebSocket = oldWebSocket;
    if (oldState === undefined) delete globalThis[stateKey]; else globalThis[stateKey] = oldState;
    for (const [key, value] of [["PI_CODEX_USAGE_DIR", oldDir], ["PI_CODEX_USAGE_STATUS", oldStatus]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  });
  async function load({ failClear = false } = {}) {
    const loader = new DefaultResourceLoader({
      cwd: directory, agentDir: directory, eventBus: bus, settingsManager: SettingsManager.inMemory(),
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [usage],
    });
    await loader.reload();
    const result = loader.getExtensions();
    assert.deepEqual(result.errors, []);
    const runner = new ExtensionRunner(result.extensions, result.runtime, directory, SessionManager.inMemory(directory), {});
    runner.bindCore({}, { getModel: () => ({ id: "offline", api: "openai-codex-responses", provider: "openai-codex" }) });
    const statuses = [], errors = [];
    runner.onError(error => errors.push(error));
    runner.setUIContext({ theme: { fg: (_color, text) => text }, notify() {}, setStatus(_key, value) {
      if (failClear && value === undefined && statuses.some(Boolean)) throw Error("fixture footer cleanup failed");
      statuses.push(value);
    } });
    runners.push(runner);
    return { runner, statuses, errors, command: args => result.extensions[0].commands.get("pi-usage").handler(args, runner.createCommandContext()) };
  }
  async function start(instance) {
    await instance.runner.emit({ type: "session_start", reason: "reload" });
    await instance.runner.emit({ type: "after_provider_response", headers });
    assert.ok(instance.statuses.at(-1)?.includes("80%"));
  }
  return { load, start, timers, bus };
}

test("late old-runner response cannot poison the replacement usage timer", async t => {
  const h = await harness(t);
  const first = await h.load(); await h.start(first);
  await first.runner.emit({ type: "session_shutdown", reason: "reload" });
  first.runner.invalidate();
  const second = await h.load(); await h.start(second);
  await first.runner.emit({ type: "after_provider_response", headers });
  assert.doesNotThrow(() => { for (const tick of h.timers.values()) tick(); });
  assert.deepEqual(first.errors, []);
  assert.equal(h.timers.size, 1);
});

test("usage cleanup releases the timer even when clearing the footer fails", async t => {
  const h = await harness(t);
  const first = await h.load({ failClear: true }); await h.start(first);
  await first.runner.emit({ type: "session_shutdown", reason: "reload" });
  first.runner.invalidate();
  assert.equal(h.timers.size, 0);
  assert.ok(first.errors.some(error => error.error === "fixture footer cleanup failed"));
});

test("host invalidation without shutdown cannot crash a later usage tick", async t => {
  const h = await harness(t);
  const first = await h.load(); await h.start(first);
  first.runner.invalidate();
  assert.doesNotThrow(() => { for (const tick of h.timers.values()) tick(); });
  assert.equal(h.timers.size, 0);
});

test("a queued retired tick cannot update or unpatch its replacement", async t => {
  const h = await harness(t);
  const first = await h.load(); await h.start(first);
  const oldTick = [...h.timers.values()][0];
  const second = await h.load(); await h.start(second);
  const wrapper = globalThis.WebSocket;
  await first.runner.emit({ type: "session_shutdown", reason: "reload" });
  first.runner.invalidate();
  const updates = second.statuses.length;
  oldTick();
  assert.equal(second.statuses.length, updates);
  assert.equal(globalThis.WebSocket, wrapper);
  assert.equal(h.timers.size, 1);
});

test("passive updates and on/off preferences remain local to each live instance", async t => {
  const h = await harness(t);
  const first = await h.load(); await h.start(first);
  const second = await h.load(); await h.start(second);
  await first.command("off");
  h.bus.emit("pi-codex-wire:allowance", { ...headers, "x-codex-primary-used-percent": "35" });
  assert.equal(first.statuses.at(-1), undefined);
  assert.ok(second.statuses.at(-1).includes("65%"));
  assert.equal(h.timers.size, 1);
  await first.command("on");
  assert.ok(first.statuses.at(-1).includes("65%"));
  assert.equal(h.timers.size, 2);
});

test("unexpected footer failures stop the timer and remain visible as warnings", async t => {
  const h = await harness(t);
  const first = await h.load(); await h.start(first);
  const warn = t.mock.method(console, "warn", () => {});
  first.runner.setUIContext({ theme: { fg() { throw Error("fixture rendering failed"); } }, setStatus() {} });
  assert.doesNotThrow(() => { for (const tick of h.timers.values()) tick(); });
  assert.equal(h.timers.size, 0);
  assert.equal(warn.mock.callCount(), 1);
  assert.match(warn.mock.calls[0].arguments[1].message, /fixture rendering failed/);
});

test("expired allowance windows stop ticking and fresh passive headers restart the footer", async t => {
  const h = await harness(t);
  const first = await h.load(); await h.start(first);
  const later = Date.now() + 3_601_000;
  t.mock.method(Date, "now", () => later);
  for (const tick of h.timers.values()) tick();
  assert.equal(h.timers.size, 0);
  assert.equal(first.statuses.at(-1), undefined);
  h.bus.emit("pi-codex-wire:allowance", headers);
  assert.equal(h.timers.size, 1);
  assert.ok(first.statuses.at(-1).includes("80%"));
});
