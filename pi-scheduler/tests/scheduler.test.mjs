import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { wrapRegisteredTool } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/wrapper.js";
import { ScheduleStore } from "../extensions/store.ts";

const theme = { bg: (_, s) => s, bold: (s) => s, fg: (_, s) => s };
function harness(directory, mode = "tui") {
  const tools = new Map(), events = new Map(), renderers = new Map(), commands = new Map();
  const sent = [], notifications = [];
  let widget;
  const file = join(directory, "session.jsonl");
  const ctx = {
    mode, cwd: directory, isIdle: () => false,
    sessionManager: { getSessionId: () => "session", getSessionFile: () => file, getEntries: () => [] },
    ui: { notify: (...args) => notifications.push(args), getToolsExpanded: () => false,
      setWidget: (_, factory) => { widget = factory?.({}, theme); } },
  };
  const pi = {
    registerTool: (tool) => tools.set(tool.name, wrapRegisteredTool({ definition: tool }, { createContext: () => ctx, getActiveTools: () => [] })),
    registerMessageRenderer: (name, fn) => renderers.set(name, fn),
    registerCommand: (name, cmd) => commands.set(name, cmd), registerShortcut() {},
    on: (name, fn) => events.set(name, fn),
    sendMessage: (message, options) => sent.push({ message, options }),
  };
  return { ctx, pi, tools, events, renderers, commands, sent, notifications, file, widget: () => widget };
}

for (const placement of ["aboveEditor", "belowEditor"]) test(`registered tools, durable acknowledgement, and widths 1–45 (${placement})`, async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const dir = mkdtempSync(join(tmpdir(), "scheduler-"));
  const old = process.env.PI_SCHEDULER_DIR, oldPlacement = process.env.PI_SCHEDULER_WIDGET_PLACEMENT;
  process.env.PI_SCHEDULER_DIR = dir;
  process.env.PI_SCHEDULER_WIDGET_PLACEMENT = placement;
  const { default: extension } = await import(`../extensions/scheduler.ts?placement=${placement}`);
  const h = harness(dir);
  extension(h.pi);
  try {
    const tool = h.tools.get("schedule");
    await assert.rejects(tool.execute("bad", { delay: "x", message: "test" }), /Invalid delay/);
    for (const mode of ["print", "json"]) {
      h.ctx.mode = mode;
      await assert.rejects(tool.execute("bad", { delay: "1m", message: "test" }), /live TUI or RPC/);
    }
    h.ctx.mode = "tui";
    const result = await tool.execute("ok", { delay: "1m", message: "hello\x1b[2J界\x07\nsecond line" });
    await h.commands.get("schedule").handler("1m user reminder", h.ctx);
    const disposable = await tool.execute("cancel", { delay: "1m", message: "discard" });
    await h.tools.get("cancel_scheduled_message").execute("cancel", { id: disposable.details.id });
    const store = new ScheduleStore(dir, "session");
    assert.equal(store.list().length, 2);
    for (const expanded of [false, true]) {
      h.ctx.ui.getToolsExpanded = () => expanded;
      for (let width = 1; width <= 45; width++) {
        const lines = h.widget().render(width);
        assert.ok(lines.every((line) => visibleWidth(line) <= width), `width ${width}`);
        assert.ok(lines.every((line) => !/[\x00-\x1f\x7f-\x9f]/.test(stripVTControlCharacters(line)) && !line.includes("\x1b[2J")));
      }
    }
    h.ctx.mode = "rpc";
    await h.events.get("session_start")({}, h.ctx);
    assert.equal(h.sent.length, 0);
    const db = new DatabaseSync(join(dir, readdirSync(dir).find((name) => name.endsWith(".sqlite"))));
    db.exec("UPDATE messages SET payload=json_set(payload, '$.dueAt', 0)");
    db.close();
    t.mock.timers.tick(5000);
    assert.equal(h.sent.length, 2, "RPC timer delivers without a TUI");
    assert.ok(h.sent.every(({ options }) => options.deliverAs === "steer" && options.triggerTurn));
    assert.equal(store.list().length, 2, "void sendMessage is not a durable acknowledgement");
    const second = harness(dir, "rpc");
    extension(second.pi);
    await second.events.get("session_start")({}, second.ctx);
    assert.equal(second.sent.length, 0, "another live owner cannot deliver claimed messages");
    await second.events.get("session_shutdown")({}, second.ctx);
    for (const { message } of h.sent) {
      assert.match(message.content, /automated scheduled delivery/);
      const renderer = h.renderers.get(message.customType)(message, {}, theme);
      for (let width = 1; width <= 45; width++) assert.ok(renderer.render(width).every((line) => visibleWidth(line) <= width && !/[\x00-\x1f\x7f-\x9f]/.test(stripVTControlCharacters(line)) && !line.includes("\x1b[2J")));
      appendFileSync(h.file, JSON.stringify({ type: "custom_message", customType: message.customType, details: message.details }) + "\n");
    }
    await h.events.get("session_shutdown")({}, h.ctx);
    assert.deepEqual(store.list(), []);
    assert.equal(result.details.delivery, "steer");
  } finally {
    await h.events.get("session_shutdown")({}, h.ctx);
    if (old === undefined) delete process.env.PI_SCHEDULER_DIR; else process.env.PI_SCHEDULER_DIR = old;
    if (oldPlacement === undefined) delete process.env.PI_SCHEDULER_WIDGET_PLACEMENT; else process.env.PI_SCHEDULER_WIDGET_PLACEMENT = oldPlacement;
    rmSync(dir, { recursive: true, force: true });
  }
});

const storeUrl = new URL("../extensions/store.ts", import.meta.url).href;
function worker(dir, code) {
  return spawn(process.execPath, ["--input-type=module", "-e", `import { ScheduleStore } from ${JSON.stringify(storeUrl)};
    const store = new ScheduleStore(${JSON.stringify(dir)}, 'shared'); ${code}`], { stdio: ["ignore", "pipe", "pipe"] });
}
async function finished(child) {
  let error = "";
  child.stderr.on("data", (data) => { error += data; });
  const [code] = await once(child, "exit");
  assert.equal(code, 0, error);
}

test("multi-process schedule/cancel/delivery transactions retain every accepted message", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scheduler-stress-"));
  try {
    await Promise.all(Array.from({ length: 4 }, (_, n) => finished(worker(dir, `
      for (let i=0;i<100;i++) store.add({ id: '${n}-'+i, sessionId:'shared', cwd:'/', createdAt:i, dueAt:0, message:'test', delivery:'steer' });
    `))));
    const store = new ScheduleStore(dir, "shared");
    assert.equal(store.list().length, 400);
    const log = join(dir, "results.jsonl");
    await Promise.all(Array.from({ length: 4 }, (_, n) => finished(worker(dir, `
      import { appendFileSync } from 'node:fs';
      for(let i=0;i<100;i++) {
        const result = store.cancel('${n}-'+i);
        for (const entry of result.cancelled) appendFileSync(${JSON.stringify(log)}, JSON.stringify({id:entry.id,kind:'cancel'})+'\\n');
        const claimed = store.claimDue(0, new Set());
        for (const entry of claimed) appendFileSync(${JSON.stringify(log)}, JSON.stringify({id:entry.id,kind:'deliver'})+'\\n');
        store.claimDue(-Infinity, new Set(claimed.map(entry=>entry.id)));
      }
    `))));
    const { readFileSync } = await import("node:fs");
    const results = readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(results.length, 400);
    assert.equal(new Set(results.map((r) => r.id)).size, 400);
    assert.deepEqual(store.list(), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("killed claimant recovers; corrupt and retired stores never look empty", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scheduler-crash-"));
  try {
    const child = worker(dir, `
      store.add({id:'recover',sessionId:'shared',cwd:'/',createdAt:0,dueAt:0,message:'recover',delivery:'steer'});
      store.claimDue(1,new Set()); console.log('claimed'); setInterval(()=>{},1000);
    `);
    await once(child.stdout, "data");
    const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
    const store = new ScheduleStore(dir, "shared");
    assert.equal(store.claimDue(1, new Set()).length, 1);
    assert.equal(store.claimDue(1, new Set()).length, 0);
    store.release();
    const dbPath = join(dir, readdirSync(dir).find((name) => name.endsWith(".sqlite")));
    const transaction = worker(dir, `
      import { DatabaseSync } from 'node:sqlite';
      const db = new DatabaseSync(${JSON.stringify(dbPath)});
      db.exec('BEGIN IMMEDIATE; DELETE FROM messages');
      console.log('uncommitted'); setInterval(()=>{},1000);
    `);
    await once(transaction.stdout, "data");
    const rolledBack = once(transaction, "exit"); transaction.kill("SIGKILL"); await rolledBack;
    assert.equal(store.list().length, 1, "an interrupted transaction cannot lose a reminder");
    assert.equal(store.cancel("recover").cancelled.length, 1);
    writeFileSync(dbPath, "corrupt");
    assert.throws(() => store.list(), /database/);
    writeFileSync(join(dir, "scheduled-messages.json"), "{");
    assert.throws(() => store.list(), /migration required/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("one-time migration preserves every session and resumes partially imported data", () => {
  const dir = mkdtempSync(join(tmpdir(), "scheduler-migration-"));
  try {
    const messages = ["first", "second"].map((sessionId) => ({ id: sessionId, sessionId, cwd: dir,
      createdAt: 1, dueAt: 2, message: "keep this reminder", delivery: "steer" }));
    // Simulate a completed first transaction followed by a migration crash.
    new ScheduleStore(dir, "first").add(messages[0]);
    const legacy = join(dir, "scheduled-messages.json");
    const original = JSON.stringify({ version: 2, messages });
    writeFileSync(legacy, original);
    assert.throws(() => new ScheduleStore(dir, "first").list(), /migration required/);
    const result = ScheduleStore.migrateLegacy(dir);
    assert.equal(result.count, 2);
    assert.equal(existsSync(legacy), false);
    assert.equal(readFileSync(result.backup, "utf8"), original);
    for (const message of messages) assert.deepEqual(new ScheduleStore(dir, message.sessionId).list(), [message]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
