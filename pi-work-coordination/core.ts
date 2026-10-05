import { randomUUID } from "node:crypto";

export type WorkTarget = { kind: "child" | "process" | "timer"; id: string };
type Resource = WorkTarget & { generation: string; pending: boolean; content?: string };
type Wait = { id: string; targets: Resource[]; mode: "any" | "all"; status: "waiting" | "ready" };
const key = (target: WorkTarget) => `${target.kind}:${target.id}`;

/** Session-owned resources, not an inference from model prose or tool names. */
export class WorkCoordinator {
  readonly sessionId: string;
  private readonly persist: (value: unknown) => void;
  private readonly resources = new Map<string, Resource>();
  private active?: Wait;
  private listeners = new Set<() => void>();
  private detachAbort?: () => void;
  private closed = false;

  constructor(sessionId: string, persist: (value: unknown) => void) {
    this.sessionId = sessionId;
    // SessionManager can retain the passed object in its resident entries.
    this.persist = (value) => persist(structuredClone(value));
  }
  get blocked(): boolean { return this.active !== undefined; }
  get waiting(): boolean { return this.active?.status === "waiting"; }
  get waitId(): string | undefined { return this.active?.id; }

  register(target: WorkTarget, pending = true, generation?: string): string {
    if (this.closed) throw new Error("work coordinator is closed");
    const prior = this.resources.get(key(target));
    if (prior?.pending && pending && (!generation || generation === prior.generation)) return prior.generation;
    const resource = { ...target, generation: generation ?? randomUUID(), pending };
    this.resources.set(key(target), resource);
    return resource.generation;
  }

  complete(target: WorkTarget, content: string, options: { notify?: boolean; generation?: string } = {}): boolean {
    if (this.closed) return false;
    const latest = this.resources.get(key(target));
    const resource = options.generation && latest?.generation !== options.generation
      ? this.active?.targets.find((item) => key(item) === key(target) && item.generation === options.generation)
      : latest;
    if (!resource || (options.generation && resource.generation !== options.generation)) return false;
    if (!resource.pending) return options.notify === false && this.active?.status === "ready" && this.active.targets.includes(resource);
    resource.pending = false;
    resource.content = content;
    const wait = this.active;
    if (!wait || wait.status !== "waiting") return false;
    const satisfied = (item: Resource) => !item.pending;
    if (!(wait.mode === "all" ? wait.targets.every(satisfied) : wait.targets.some(satisfied))) return false;
    try { this.persist({ ...wait, status: "ready", content }); }
    catch (error) { resource.pending = true; delete resource.content; throw error; }
    wait.status = "ready";
    this.detachAbort?.();
    this.detachAbort = undefined;
    this.changed();
    return true;
  }

  begin(targets: WorkTarget[], mode: "any" | "all" = "any", signal?: AbortSignal): { waiting: boolean; waitId?: string; completed?: string[] } {
    signal?.throwIfAborted();
    if (this.closed) throw new Error("work coordinator is closed");
    if (!targets.length || targets.length > 64) throw new Error("Waiting needs 1–64 existing resource targets");
    const selected = [...new Map(targets.map((target) => [key(target), target])).values()].map((target) => {
      const resource = this.resources.get(key(target));
      if (!resource) throw new Error(`No session-owned ${target.kind} resource ${target.id}; create it before waiting`);
      return resource;
    });
    const done = selected.filter((item) => !item.pending);
    if (mode === "all" ? done.length === selected.length : done.length > 0)
      return { waiting: false, completed: done.map((item) => item.content ?? `${key(item)} already completed`) };
    if (this.active) throw new Error("A wait is already in progress");
    const wait: Wait = { id: randomUUID(), targets: selected, mode, status: "waiting" };
    // No await between validation, generation capture, durable append and admission.
    this.persist(wait);
    this.active = wait;
    const abort = () => this.cancel("aborted");
    signal?.addEventListener("abort", abort, { once: true });
    this.detachAbort = () => signal?.removeEventListener("abort", abort);
    if (signal?.aborted) this.cancel("aborted");
    this.changed();
    return { waiting: this.waiting, waitId: wait.id };
  }

  cancel(reason: string): void {
    if (!this.active) return;
    this.persist({ ...this.active, status: "cancelled", reason });
    this.active = undefined;
    this.detachAbort?.();
    this.detachAbort = undefined;
    this.changed();
  }

  /** Keep the tool pending; the native agent loop consumes the returned result. */
  async wait(targets: WorkTarget[], mode: "any" | "all", timeoutMs: number, signal?: AbortSignal) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 3_600_000) throw new Error("Wait timeout must be between 1 ms and 1 hour");
    const result = this.begin(targets, mode, signal);
    if (!result.waiting) return { completed: result.completed ?? [], timed_out: false };
    const active = this.active!;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const reason = await Promise.race([
        this.untilReady(signal).then(() => active.status === "ready" ? "completed" : "interrupted"),
        new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), timeoutMs); }),
      ]);
      return { completed: active.targets.filter(item => !item.pending).map(item => item.content ?? `${key(item)} completed`),
        timed_out: reason === "timeout", ...(reason === "interrupted" ? { interrupted: true } : {}) };
    } finally {
      clearTimeout(timer);
      if (this.active === active) this.cancel("wait-returned");
    }
  }

  async untilReady(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (!this.waiting) return;
    await new Promise<void>((resolve, reject) => {
      const finish = () => {
        if (this.waiting && !signal?.aborted) return;
        this.listeners.delete(finish);
        signal?.removeEventListener("abort", finish);
        if (signal?.aborted) reject(signal.reason); else resolve();
      };
      this.listeners.add(finish);
      signal?.addEventListener("abort", finish, { once: true });
      finish();
    });
  }

  close(persistCancellation = true): void {
    if (this.closed) return;
    try { if (persistCancellation) this.cancel("session-shutdown"); }
    finally { this.closed = true; this.active = undefined; this.detachAbort?.(); this.changed(); this.resources.clear(); }
  }
  private changed(): void { for (const listener of this.listeners) listener(); }
}

// Jiti and the SDK may load separate module instances in one process.
const registryKey = Symbol.for("gunba.pi-work-coordination.v1");
const globalRegistry = globalThis as typeof globalThis & { [registryKey]?: { sessions: Map<string, WorkCoordinator> } };
export const registry = globalRegistry[registryKey] ??= { sessions: new Map() };
export const getWorkCoordinator = (sessionId: string): WorkCoordinator | undefined => registry.sessions.get(sessionId);
export function releaseWorkCoordinator(sessionId: string): void {
  const coordinator = registry.sessions.get(sessionId);
  coordinator?.close();
  if (registry.sessions.get(sessionId) === coordinator) registry.sessions.delete(sessionId);
}
export function registerWorkResource(sessionId: string, target: WorkTarget, pending = true, generation?: string): string | undefined {
  return getWorkCoordinator(sessionId)?.register(target, pending, generation);
}
export function completeWorkResource(sessionId: string, target: WorkTarget, content: string, options: { notify?: boolean; generation?: string } = {}): boolean {
  return getWorkCoordinator(sessionId)?.complete(target, content, options) ?? false;
}
