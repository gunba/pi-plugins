import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createEventBus, DefaultResourceLoader, ExtensionRunner, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

const headers = { "x-codex-primary-used-percent": "20", "x-codex-primary-window-minutes": "300", "x-codex-primary-reset-after-seconds": "3600" };

async function harness(t) {
  const directory = mkdtempSync(join(tmpdir(), "pi-usage-lifecycle-"));
  const oldDir = process.env.PI_CODEX_USAGE_DIR, oldStatus = process.env.PI_CODEX_USAGE_STATUS;
  const oldWebSocket = globalThis.WebSocket;
  process.env.PI_CODEX_USAGE_DIR = directory;
  process.env.PI_CODEX_USAGE_STATUS = "on";
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
    assert.equal(globalThis.WebSocket, oldWebSocket, "allowance tracking must not intercept WebSocket");
    for (const [key, value] of [["PI_CODEX_USAGE_DIR", oldDir], ["PI_CODEX_USAGE_STATUS", oldStatus]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  });
  async function load({ failClear = false, mode = "print", oauth = false } = {}) {
    const loader = new DefaultResourceLoader({
      cwd: directory, agentDir: directory, eventBus: bus, settingsManager: SettingsManager.inMemory(),
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [usage],
    });
    await loader.reload();
    const result = loader.getExtensions();
    assert.deepEqual(result.errors, []);
    const runner = new ExtensionRunner(result.extensions, result.runtime, directory, SessionManager.inMemory(directory), { isUsingOAuth: () => oauth });
    let model = { id: "offline", api: "openai-codex-responses", provider: "openai-codex" };
    runner.bindCore({ getThinkingLevel: () => "off" }, { getContextUsage: () => undefined, getModel: () => model });
    const statuses = [], errors = [];
    runner.onError(error => errors.push(error));
    runner.setUIContext({ theme: { fg: (_color, text) => text }, notify() {}, setStatus(_key, value) {
      if (failClear && value === undefined && statuses.some(Boolean)) throw Error("fixture footer cleanup failed");
      statuses.push(value);
    } }, mode);
    runners.push(runner);
    return { runner, statuses, errors, select: async next => { model = next; await runner.emit({ type: "model_select", model }); },
      command: args => result.extensions[0].commands.get("pi-usage").handler(args, runner.createCommandContext()) };
  }
  async function start(instance) {
    await instance.runner.emit({ type: "session_start", reason: "reload" });
    bus.emit("pi-codex-wire:allowance", headers);
    assert.ok(instance.statuses.at(-1)?.includes("80%"));
  }
  return { load, start, timers, bus, directory };
}

test("allowance badges distinguish weekly quota from the actual reset countdown", async t => {
	let now = Date.UTC(2026, 9, 2);
	t.mock.method(Date, "now", () => now);
	const h = await harness(t), publications = [];
	h.bus.on("pi-ui/discover-v2", probe => { probe.presentation = { publish: (_id, value) => publications.push(value) }; });
	const instance = await h.load({ mode: "rpc" }); await h.start(instance);
	h.bus.emit("pi-codex-wire:allowance", {
		"x-codex-secondary-used-percent": "60", "x-codex-secondary-window-minutes": "10080",
		"x-codex-secondary-reset-after-seconds": "93600",
	});
	const reset = now + 93_600_000;
	assert.deepEqual(publications.at(-1).badges.map(({ label, value, meter }) => ({ label, value, resetsAt: meter.resetsAt })),
		[{ label: "Weekly", value: "40% left", resetsAt: reset }]);
	// Desk counts down from the reset time, so the published view does not change as time passes.
	const before = JSON.stringify(publications.at(-1));
	now += 60 * 60_000; for (const tick of h.timers.values()) tick();
	assert.equal(JSON.stringify(publications.at(-1)), before);
	now += 26 * 60 * 60_000; for (const tick of h.timers.values()) tick();
	assert.deepEqual(publications.at(-1).badges, [], "expired percentages are not a fresh allowance");
});

test("switching to Claude does not show cached Codex allowance as its capacity", async t => {
  const h = await harness(t), publications = [];
  h.bus.on("pi-ui/discover-v2", probe => { probe.presentation = { publish: (_id, value) => publications.push(value) }; });
  const instance = await h.load({ mode: "rpc" }); await h.start(instance);
  await instance.select({ id: "claude-fixture", provider: "anthropic", api: "anthropic-messages" });
  const view = publications.at(-1);
  assert.deepEqual(view.badges, []);
  assert.ok(view.data.items.every(item => !item.meter));
  assert.match(view.data.items[0].body, /not provided/i);
  assert.equal(h.timers.size, 0);
  await instance.select({ id: "codex-fixture", provider: "openai-codex", api: "openai-codex-responses" });
  assert.match(publications.at(-1).badges[0].value, /80%/);
});

test("Claude allowance uses normal response headers and is kept apart from Codex's", async t => {
  const h = await harness(t), publications = [];
  h.bus.on("pi-ui/discover-v2", probe => { probe.presentation = { publish: (_id, value) => publications.push(value) }; });
  const instance = await h.load({ mode: "rpc", oauth: true }); await h.start(instance);
  const codexBefore = readFileSync(join(h.directory, "usage.json"), "utf8");
  await instance.select({ id: "claude-fixture", provider: "anthropic", api: "anthropic-messages", baseUrl: "https://api.anthropic.com" });
  await instance.runner.emit({ type: "before_provider_request", payload: {} });
  await instance.runner.emit({ type: "after_provider_response", status: 200, headers: {
    "anthropic-ratelimit-unified-5h-utilization": "0.25",
    "anthropic-ratelimit-unified-5h-reset": String(Math.floor(Date.now() / 1000) + 3600),
  } });
  assert.equal(publications.at(-1).badges[0].value, "75% left");
  assert.ok(publications.at(-1).badges[0].meter.resetsAt > Date.now());
  assert.match(publications.at(-1).badges[0].description, /Claude/);
  assert.equal(readFileSync(join(h.directory, "usage.json"), "utf8"), codexBefore);
  const saved = JSON.parse(readFileSync(join(h.directory, "usage-claude.json"), "utf8"));
  assert.equal(saved.claude.primary.usedPercent, 25);
  assert.equal(saved.codex, undefined);
});

test("API-key Claude headers and another session's response do not replace allowance", async t => {
  const h = await harness(t), parent = await h.load(); await h.start(parent);
  const other = await h.load({ oauth: false });
  await other.runner.emit({ type: "session_start", reason: "new" });
  await other.select({ id: "claude-fixture", provider: "anthropic", api: "anthropic-messages", baseUrl: "https://api.anthropic.com" });
  await other.runner.emit({ type: "before_provider_request", payload: {} });
  await other.runner.emit({ type: "after_provider_response", status: 200, headers: { "anthropic-ratelimit-unified-5h-utilization": "0.9" } });
  assert.equal(other.statuses.at(-1), undefined);
  assert.match(parent.statuses.at(-1), /80%/);
});

test("late old-runner request cannot poison the replacement usage timer", async t => {
  const h = await harness(t);
  const first = await h.load(); await h.start(first);
  await first.runner.emit({ type: "session_shutdown", reason: "reload" });
  first.runner.invalidate();
  const second = await h.load(); await h.start(second);
  await first.runner.emit({ type: "before_provider_request" });
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

test("a queued retired tick cannot update or clear its replacement", async t => {
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

