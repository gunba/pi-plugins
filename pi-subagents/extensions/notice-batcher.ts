import type { ParentNotice } from "./subagent-runtime.ts";

export const NOTICE_BATCH_MS = 50;
export type NoticeBatch = { messageIds: string[]; notices: ParentNotice[] };
export function noticeBatch(notices: ParentNotice[]): NoticeBatch {
  return { messageIds: notices.map((notice) => notice.messageId), notices };
}
export function noticeBatchContent(notices: ParentNotice[]): string {
  return notices.map((notice) => notice.content).join("\n\n");
}

/** Admission must already be durable. Failed dispatch stays pending for the
 * next lifecycle event/reload, never a self-triggering retry loop. */
export class NoticeBatcher {
  private pending = new Map<string, ParentNotice>();
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;
  private sending = false;
  private readonly send: (notices: ParentNotice[]) => void;
  private readonly error: (error: unknown) => void;
  private readonly drained: () => void;
  constructor(send: (notices: ParentNotice[]) => void, error: (error: unknown) => void = () => {}, drained: () => void = () => {}) {
    this.send = send;
    this.error = error;
    this.drained = drained;
  }
  get size(): number { return this.pending.size; }
  add(notice: ParentNotice): void {
    if (this.closed) return;
    this.pending.set(notice.messageId, notice);
    if (this.sending) {
      if (!this.timer) this.timer = setTimeout(() => { this.timer = undefined; this.flush(); }, 0);
    }
    else if (notice.priority === "urgent" || notice.priority === "action-required") this.flush();
    else if (!this.timer) this.timer = setTimeout(() => { this.timer = undefined; this.flush(); }, NOTICE_BATCH_MS);
  }
  flush(): void {
    if (this.closed || this.sending || !this.pending.size) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const batch = [...this.pending.values()];
    this.sending = true;
    try {
      this.send(batch);
      for (const notice of batch) this.pending.delete(notice.messageId);
      if (!this.pending.size) this.drained();
    } catch (error) { this.error(error); }
    finally { this.sending = false; }
  }
  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.pending.clear(); // Durable inbox is the replay source.
  }
}
