# pi-subagents

Run delegated work in isolated background `pi` processes. Every subagent has a
clean context, the normal installed plugin stack, a human first name chosen by
its parent, and a separate generated task id.

## Tools

- `spawn(task, name, thinking?)` starts one delegated task. `name` is a distinct
  first name such as `Maya`; Pi assigns a `task-…` id. `thinking` defaults to
  the parent's current level and can only be equal or lower.
- `message(to, body, reply_to?, wait?)` uses the cooperative agent mailbox.
  Address an agent by first name or task id, use `wait:true` for a request/reply,
  and use `reply_to` to answer a request. Addressing a finished agent resumes
  its saved session.
- `inspect_agent(agent)` lets `main` read any descendant's active session branch
  directly. Inspection includes user messages, thinking blocks, tool calls and
  results, provider errors, model/thinking changes, compactions, and assistant
  messages.
- `control_agent(agent, action, message?, thinking?)` lets `main` directly
  `steer`, queue a `follow_up`, request a graceful `abort`, or `set_thinking`
  for any descendant at any depth.
- `kill(name, reason?)` hard-stops one subagent and its descendants. `*` stops
  every direct child subtree.
- `wait()` yields until a direct child needs attention or finishes. It returns
  immediately when there is no child work or unread child mail.

The normal orchestration loop is `spawn` → `wait` → respond with `message` or
intervene with `inspect_agent`/`control_agent` → `wait`. Completion messages
contain a result-file path rather than inlining the final response into the
parent's context.

## Orchestration dashboard

A compact line above the editor shows active, queued, completed, and
attention-needed counts. `/subagents` opens a focused overlay for the full run;
`/subagents <name|task-id>` opens it on one agent. `/subagent` is an equivalent
singular command and also supports inline messages and `kill`.

The dashboard provides:

- a virtualized, searchable parent/child tree that remains bounded with large
  or deeply nested teams;
- first name, task id, state, activity, model, thinking level, usage, duration,
  and task summary;
- the selected agent's live active-branch session tail and recent coordination
  feed;
- direct actions: `m` cooperative message, `s` steer, `f` follow-up, `t`
  thinking, `a` graceful abort, and `x` hard kill;
- arrow or `j`/`k` navigation, `/` search, and Page Up/Page Down transcript
  scrolling.

## Behaviour

- **Bounded fan-out.** A parent runs at most 12 direct children concurrently by
  default. Additional tasks remain visible as `queued` and launch as slots free.
  This bounds wide bursts without preventing deep orchestration.
- **Event-driven waiting.** Parents watch their own inbox and use a low-frequency
  fallback instead of repeatedly scanning every beacon in the run. Direct-child
  indexes keep nested wait checks proportional to each parent's own children.
- **Snapshot rendering.** The compact indicator and dashboard read one team
  snapshot per refresh. Rendering performs no filesystem scans, and assistant
  previews stored in beacons are bounded.
- **Atomic state.** Beacon replacement and mailbox creation are atomic. Mail ids
  are UUIDs, replies are correlated with their expected sender, and selected
  first names are unique within a run.
- **Live control.** Running children watch a dedicated control inbox. Steers,
  follow-ups, aborts, and thinking changes are delivered into the target Pi
  session without routing through intermediate parents.
- **Branch-aware inspection.** Session reading uses Pi's `SessionManager`, follows
  the active branch, retains the newest bounded window, and caches unchanged
  session files.
- **Nested approval.** A nested `spawn` asks `main` for deliberate approval. Set
  `subagents.nestedSpawnApproval` to `user` to route each request through a user
  confirmation modal.
- **Resumable sessions.** A completed or attention-needed agent exits after
  writing its result. Re-addressing it starts the same isolated session with its
  first name, task id, model, and thinking level intact.
- **Deep watchdog.** The root watchdog can identify and stop any non-coordinating
  descendant. Queued, waiting, and parent agents with live children are not
  treated as stuck.
- **Settled lifecycle.** Results publish only after Pi emits `agent_settled`, so
  automatic retry, compaction retry, and queued follow-ups finish first.

## Configuration

Environment variables:

- `PI_SUBAGENTS_DIR` — run storage base (default
  `~/.pi/agent/subagents`).
- `PI_SUBAGENTS_MAX_ACTIVE` — concurrent direct children per parent (default
  `12`).
- `PI_SUBAGENTS_STALE_MS` — watchdog threshold outside a tool call (default
  `600000`).
- `PI_SUBAGENTS_ACTIVE_TOOL_STALE_MS` — watchdog threshold during a tool call
  (default `1800000`).
- `PI_SUBAGENTS_RUN_TTL_MS` — completed-run retention before startup cleanup
  (default `86400000`).
- `PI_SUBAGENTS_FEED_TAIL` — recent dashboard feed rows (default `8`).
- `PI_SUBAGENTS_NESTED_SPAWN_APPROVAL` — `agent` or `user`.

Nested approval can also be configured globally in
`~/.pi/agent/settings.json` or per trusted project in `.pi/settings.json`:

```json
{
  "subagents": {
    "nestedSpawnApproval": "user"
  }
}
```

## Storage

```text
~/.pi/agent/subagents/<run>/<name>/beacon.json
~/.pi/agent/subagents/<run>/<name>/children/
~/.pi/agent/subagents/<run>/<name>/inbox/
~/.pi/agent/subagents/<run>/<name>/control/
~/.pi/agent/subagents/<run>/<name>/launch.json
~/.pi/agent/subagents/<run>/results/
~/.pi/agent/subagents/<run>/sessions/
~/.pi/agent/subagents/<run>/feed.log
```

Child processes receive `PI_SUBAGENT_NAME`, `PI_SUBAGENT_TASK_ID`,
`PI_SUBAGENT_PARENT`, and `PI_SUBAGENT_RUN`. Their sessions use the task id
inside the run-local session directory, so they remain resumable without
appearing in `/resume`.
