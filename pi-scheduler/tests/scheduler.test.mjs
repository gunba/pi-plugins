import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

function createHarness() {
  const commands = new Map();
  const tools = new Map();
  const events = new Map();
  const sentMessages = [];
  const notifications = [];

  const pi = {
    registerCommand(name, command) {
      commands.set(name, command);
    },
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
    registerShortcut() {},
    on(name, handler) {
      const handlers = events.get(name) ?? [];
      handlers.push(handler);
      events.set(name, handlers);
    },
    sendUserMessage(message, options) {
      sentMessages.push({ message, options });
    },
  };

  const ctx = {
    cwd: "/project",
    mode: "tui",
    sessionManager: {
      getSessionId() {
        return "session-1";
      },
      getSessionFile() {
        return "/sessions/session-1.jsonl";
      },
    },
    isIdle() {
      return false;
    },
    ui: {
      notify(message, type) {
        notifications.push({ message, type });
      },
      setWidget() {},
      getToolsExpanded() {
        return false;
      },
    },
  };

  return { commands, tools, events, sentMessages, notifications, pi, ctx };
}

test("agent schedules steer while user commands schedule follow-ups", async () => {
  const schedulerDir = mkdtempSync(join(tmpdir(), "pi-scheduler-test-"));
  const previousSchedulerDir = process.env.PI_SCHEDULER_DIR;
  process.env.PI_SCHEDULER_DIR = schedulerDir;

  try {
    const { default: schedulerExtension } = await import(`../extensions/scheduler.ts?test=${Date.now()}`);
    const harness = createHarness();
    schedulerExtension(harness.pi);

    const tool = harness.tools.get("schedule");
    assert.ok(tool);
    const toolResult = await tool.execute(
      "tool-call-1",
      { delay: "1m", message: "agent reminder" },
      undefined,
      undefined,
      harness.ctx,
    );
    assert.equal(toolResult.details.delivery, "steer");

    const command = harness.commands.get("schedule");
    assert.ok(command);
    await command.handler("1m user reminder", harness.ctx);

    const storePath = join(schedulerDir, "scheduled-messages.json");
    const stored = JSON.parse(readFileSync(storePath, "utf8"));
    assert.equal(stored.version, 2);
    assert.deepEqual(
      stored.messages.map(({ message, delivery }) => ({ message, delivery })),
      [
        { message: "agent reminder", delivery: "steer" },
        { message: "user reminder", delivery: "followUp" },
      ],
    );

    for (const message of stored.messages) message.dueAt = Date.now() - 1;
    writeFileSync(storePath, `${JSON.stringify(stored, null, 2)}\n`);

    for (const handler of harness.events.get("session_start") ?? []) {
      await handler({ reason: "startup" }, harness.ctx);
    }
    for (const handler of harness.events.get("session_shutdown") ?? []) {
      await handler({ reason: "quit" }, harness.ctx);
    }

    assert.deepEqual(harness.sentMessages, [
      { message: "agent reminder", options: { deliverAs: "steer" } },
      { message: "user reminder", options: { deliverAs: "followUp" } },
    ]);

    const deliveredStore = JSON.parse(readFileSync(storePath, "utf8"));
    assert.deepEqual(deliveredStore, { version: 2, messages: [] });
  } finally {
    if (previousSchedulerDir === undefined) delete process.env.PI_SCHEDULER_DIR;
    else process.env.PI_SCHEDULER_DIR = previousSchedulerDir;
    rmSync(schedulerDir, { recursive: true, force: true });
  }
});
