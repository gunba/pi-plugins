export type AgentWaitResult = { message: string; timed_out: boolean };

/** Notification activity only. The native session owns message content and execution. */
export class WorkCoordinator {
  readonly sessionId: string;
  private readonly unread = new Set<string>();
  private active?: { finish: (result?: AgentWaitResult, error?: unknown) => void };
  private closed = false;

  constructor(sessionId: string) { this.sessionId = sessionId; }
  get blocked(): boolean { return this.active !== undefined; }
  get waiting(): boolean { return this.blocked; }
  get hasUnread(): boolean { return this.unread.size > 0; }

  /** Call after a message is admitted to the native recipient, not before delivery. */
  notify(messageIds: Iterable<string>): void {
    if (this.closed) return;
    for (const id of messageIds) this.unread.add(id);
    if (this.unread.size) this.active?.finish({ message: "Wait completed.", timed_out: false });
  }

  /** Release notifications consumed in context or returned to the owner's durable task queue. */
  consume(messageIds: Iterable<string>): void {
    for (const id of messageIds) this.unread.delete(id);
  }

  cancel(_reason: string): void {
    this.active?.finish({ message: "Wait interrupted by new input.", timed_out: false });
  }

  async wait(timeoutMs: number, signal?: AbortSignal): Promise<AgentWaitResult> {
    signal?.throwIfAborted();
    if (this.closed) throw new Error("agent mailbox is closed");
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 3_600_000)
      throw new Error("Wait timeout must be between 1 ms and 1 hour");
    if (this.active) throw new Error("A wait is already in progress");
    if (this.unread.size) return { message: "Wait completed.", timed_out: false };
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (result?: AgentWaitResult, error?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        this.active = undefined;
        if (result) resolve(result); else reject(error);
      };
      const abort = () => finish(undefined, signal!.reason);
      const timer = setTimeout(() => finish({ message: "Wait timed out.", timed_out: true }), timeoutMs);
      this.active = { finish };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.cancel("session-shutdown");
    this.unread.clear();
  }
}

// Jiti and the SDK may load separate module instances in one process.
const registryKey = Symbol.for("gunba.pi-agent-mailbox.v1");
const globalRegistry = globalThis as typeof globalThis & { [registryKey]?: { sessions: Map<string, WorkCoordinator> } };
export const registry = globalRegistry[registryKey] ??= { sessions: new Map() };
export const getWorkCoordinator = (sessionId: string): WorkCoordinator | undefined => registry.sessions.get(sessionId);
export function releaseWorkCoordinator(sessionId: string): void {
  const coordinator = registry.sessions.get(sessionId);
  coordinator?.close();
  if (registry.sessions.get(sessionId) === coordinator) registry.sessions.delete(sessionId);
}
