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
  const messageRenderers = new Map();

  const pi = {
    registerCommand(name, command) {
      commands.set(name, command);
    },
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
    registerMessageRenderer(name, renderer) {
      messageRenderers.set(name, renderer);
    },
    registerShortcut() {},
    on(name, handler) {
      const handlers = events.get(name) ?? [];
      handlers.push(handler);
      events.set(name, handlers);
    },
    sendMessage(message, options) {
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

  return { commands, tools, events, sentMessages, notifications, messageRenderers, pi, ctx };
}

test("agents can cancel schedules and due messages have explicit scheduler provenance", async () => {
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

    const disposableResult = await tool.execute(
      "tool-call-2",
      { delay: "1m", message: "cancel me" },
      undefined,
      undefined,
      harness.ctx,
    );

    const cancelTool = harness.tools.get("cancel_scheduled_message");
    assert.ok(cancelTool);
    const cancelResult = await cancelTool.execute(
      "tool-call-3",
      { id: disposableResult.details.id },
      undefined,
      undefined,
      harness.ctx,
    );
    assert.equal(cancelResult.details.count, 1);
    assert.equal(cancelResult.details.cancelled[0].message, "cancel me");

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

    const renderer = harness.messageRenderers.get("pi-scheduler-scheduled-message");
    assert.ok(renderer);
    assert.equal(harness.sentMessages.length, 2);
    assert.deepEqual(
      harness.sentMessages.map(({ message, options }) => ({
        customType: message.customType,
        display: message.display,
        rawMessage: message.details.message,
        delivery: options.deliverAs,
        triggerTurn: options.triggerTurn,
      })),
      [
        {
          customType: "pi-scheduler-scheduled-message",
          display: true,
          rawMessage: "agent reminder",
          delivery: "steer",
          triggerTurn: true,
        },
        {
          customType: "pi-scheduler-scheduled-message",
          display: true,
          rawMessage: "user reminder",
          delivery: "followUp",
          triggerTurn: true,
        },
      ],
    );
    for (const { message } of harness.sentMessages) {
      assert.match(message.content, /automated scheduled delivery from pi-scheduler/);
      assert.match(message.content, /delayed context, not as a new message typed by the user at delivery time/);
      assert.match(message.content, /<scheduled-message>[\s\S]+<\/scheduled-message>/);
    }

    const theme = {
      bg(_color, text) { return text; },
      bold(text) { return text; },
      fg(_color, text) { return text; },
    };
    const rendered = renderer(
      { details: harness.sentMessages[0].message.details },
      { expanded: false },
      theme,
    ).render(100).join("\n");
    assert.match(rendered, /Scheduled message #[a-f0-9]{8}/);
    assert.match(rendered, /agent reminder/);
    assert.doesNotMatch(rendered, /automated scheduled delivery/);

    const deliveredStore = JSON.parse(readFileSync(storePath, "utf8"));
    assert.deepEqual(deliveredStore, { version: 2, messages: [] });
  } finally {
    if (previousSchedulerDir === undefined) delete process.env.PI_SCHEDULER_DIR;
    else process.env.PI_SCHEDULER_DIR = previousSchedulerDir;
    rmSync(schedulerDir, { recursive: true, force: true });
  }
});
