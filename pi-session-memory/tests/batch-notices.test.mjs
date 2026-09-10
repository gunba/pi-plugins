import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { pruneCompactedSession } from "../extensions/session-memory.ts";
import { NOTICE_ENTRY, undispatchedNotices } from "../../pi-subagents/extensions/subagent-runtime.ts";

test("compacted batched notices retain every delivery ID without retaining report bodies", () => {
  const manager = SessionManager.inMemory();
  manager.appendMessage({ role: "user", content: "initial", timestamp: 1 });
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
