# Agent waiting

`wait_agent({timeout_ms?})` waits for an agent message or final-status
notification. Already queued notifications return immediately; new input also
ends the wait. The tool stays pending and returns through Pi's normal agent loop. It never ends the turn or starts a separate wake.

The default timeout is 30 seconds. Shorter requests are clamped to 10 seconds;
the maximum is one hour, matching Codex V2's default limits. A timeout returns
`{message, timed_out: true}` without stopping child work. Interruption, shutdown
and branch replacement release the wait. Native SDK, RPC and terminal sessions
share the same implementation.

Use `write_stdin` for a running process.

## Integration

`ensureWorkCoordination(pi)` installs once per runtime event bus.
Message owners retain their durable inbox/outbox and notify the coordinator
after durable admission. Explicit follow-ups can notify a pending wait before
entering context at a native boundary. The coordinator tracks unread notification
IDs, not task, process or timer ownership. Context consumption acknowledges only the IDs
included in that context, preserving messages arriving during another request.

Ordinary messages and results do not start an idle agent. Waiting agents receive
them through the pending tool; idle agents retain them for their next task.
`followup_task` separately requests a turn; the mailbox itself never starts one.

`getWorkCoordinator(sessionId)` exposes the pending-wait state to plan controls.
No wait scheduler or resource journal is created. Historical unadmitted
completion records remain recoverable as context without replaying old work.

```sh
node --test pi-work-coordination/tests/*.test.mjs
```
