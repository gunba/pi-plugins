# Agent waiting

`wait_agent({ids, timeout_ms?})` waits for any selected child to finish its current
task. The tool stays pending, like Codex's targeted agent wait. Completion returns
a normal tool result to Pi's agent loop: no turn termination or separate wake.

The default timeout is 30 seconds, with a maximum of one hour. A timeout returns
`timed_out: true` without stopping child work. Already-completed work returns
immediately. User input, interruption, shutdown and branch replacement release
the wait. Roots and SDK children use the same tool implementation.

Use `write_stdin` to wait for a running process. `schedule` is for timed reminders.
The former `wait_for_work` and `cancel_work_wait` tools are removed.

## Integration

`ensureWorkCoordination(pi)` installs once on the runtime's shared event bus.
Starting background work does not itself force a wait or change plan continuation.

Child owners register and complete session-owned resources. Generations separate
successive tasks on a reused child ID. Durable child notices retain their own
delivery path; completion also releases a matching pending tool. Notice retries
can identify that match without requesting an additional wake.

`getWorkCoordinator(sessionId)` exposes ownership and wait state to integrations.
Wait transitions are immutable native custom entries. Historical unadmitted
completion records remain recoverable as context on reload, without starting
the old task. Resource ownership is rebuilt from actual child work, not old IDs.

```sh
node --test pi-work-coordination/tests/*.test.mjs
```
