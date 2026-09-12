import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { pruneCompactedSession } from "../extensions/session-memory.ts";
import { NOTICE_ENTRY, undispatchedNotices } from "../../pi-subagents/extensions/subagent-runtime.ts";

test("compacted batched notices retain every delivery ID without retaining report bodies", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "pi-memory-notices-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const manager = SessionManager.create(directory, directory);
  manager.appendMessage({ role: "user", content: "initial", timestamp: 1 });
  manager.appendMessage({ role: "assistant", content: [], timestamp: 1,
    api: "test", provider: "test", model: "test", stopReason: "stop",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  const notices = ["first", "second"].map(messageId => ({ messageId, kind: "report", childId: "child", content: "private report ".repeat(1000) }));
  for (const notice of notices) manager.appendCustomEntry(NOTICE_ENTRY, notice);
  const noticeId = manager.appendCustomMessageEntry("pi-subagents/notice", "large notice ".repeat(1000), true,
    { messageIds: notices.map(notice => notice.messageId), notices });
  const kept = manager.appendMessage({ role: "user", content: "keep", timestamp: 2 });
  manager.appendCompaction("summary", kept, 10000);
  pruneCompactedSession(manager);
  assert.deepEqual(manager.getEntry(noticeId).details, { messageIds: ["first", "second"] });
  assert.deepEqual(manager.getEntry(noticeId).content, []);
  assert.deepEqual(undispatchedNotices(manager.getBranch()), []);
});
