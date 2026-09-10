# Explicit work waits

Pi 0.85.1 or newer is required. The subagent, goal and scheduler extensions install this shared policy once per session event bus. Managed SDK children install it explicitly, with discovery disabled.

`wait_for_work({targets:[{kind:"child"|"process"|"timer",id}],mode:"any"|"all"})` yields only for registered, session-owned resources. Use it alone, after independent useful work is complete. Pi terminates a tool batch only when every result has `terminate:true`. Merely creating a child, process or timer does not stop work or goal rounds. A resource already complete returns immediately without another wake.

`cancel_work_wait({})` cancels the wait, not the resources. Direct user input also cancels it. Resource cancellation must be published as a completion event. Reload, shutdown and branch replacement cancel waits: process ownership is not reconstructed from old IDs. Timer and child owners re-register actual resources. Interrupted SDK children return `aborted`, not a false `toolUse` error.

Goals do not enqueue continuation rounds while a wait is pending or while its completion message has not reached model context. With `mode:"all"`, partial results do not wake the model. Urgent child errors and explicit action requests interrupt a wait. SDK child prompt promises remain outstanding while waiting and resume on the event; there is no polling prompt.

## Integration API

Import from `pi-work-coordination/index.ts`:

```ts
ensureWorkCoordination(pi); // during extension setup
// Only after a real handle exists:
const generation = registerWorkResource(sessionId, {kind:"process", id});
// On exit, cancellation or disposal:
completeWorkResource(sessionId, {kind:"process", id}, "Process finished", {generation});
```

Pass the generation to completion callbacks; a late callback cannot satisfy a wait for a reused ID. Resource owners with their own durable generation may pass it as the fourth registration argument. An existing wait retains its original generation.

`getWorkCoordinator(sessionId)` exposes `waiting`, `blocked`, `begin`, `cancel`, `untilReady` and `retryWake`. `blocked` includes an event awaiting context admission. Do not use it as evidence of useful work being complete.

`completeWorkResource` returns whether this event satisfies the active wait. The default emits one wake only for a matching wait. `notify:false` transfers wake delivery to the caller, which must send its own message if the return value is true. This is used for durable child notice batches and scheduled messages. Repeated external completion is retryable until context consumes the wait; ordinary internally emitted wakes are not repeated.

Wait transitions use immutable session custom entries. A failed durable admission publishes no wait. A failed synchronous wake can be retried at `agent_settled` or explicitly with `retryWake`; no polling retry runs. Reload exposes any unadmitted owned completion message without automatically restarting the old goal. Pi's void `sendMessage` API does not provide an asynchronous persistence acknowledgement, so crash recovery is at-least-once, with stable wait/notice IDs, not exactly-once delivery.

Tests: `node --test pi-work-coordination/tests/*.test.mjs pi-goal/tests/work-wait.test.mjs pi-subagents/tests/explicit-wait-sdk.test.mjs`.
