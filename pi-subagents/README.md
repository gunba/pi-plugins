# pi-subagents

Run delegated work in isolated background `pi` processes. Each task has a
canonical path under `/root`, a clean context, a shared working directory, and
a resumable Pi session.

## Tools

- `spawn_agent(task_name, message, thinking?)` starts a direct child at
  `<caller-path>/<task_name>`.
- `send_message(target, message)` sends a short message. Downward messages
 instruct or resume a child; upward messages wait for the ancestor's answer.
- `restart_agent(target, message)` terminates a stuck process and resumes its
  persisted conversation in a fresh process with a recovery instruction.
- `wait_agent()` waits until a child sends mail, finishes, stalls, or the user
  interrupts.
- `kill_agent(target)` stops one task subtree. Target `*` stops every direct
  child subtree and clears their pending mail.

Task names contain lowercase ASCII letters, digits, and underscores. Targets
may be canonical `/root/...` paths or paths relative to the caller. Root can
address every descendant; child agents can address root, their parent, and
their own subtree.

The orchestration loop is `spawn_agent` → `wait_agent` → optionally
`send_message` or `restart_agent` → `wait_agent`. After the user interrupts a
wait, `kill_agent("*")` abandons all delegated work.

## Dashboard

A compact line above the editor shows active, queued, completed, stopped, and
attention-needed counts. `/subagents` opens a full-terminal overlay;
`/subagents <task-path>` opens it on one task. `/subagent` supports inline
messages and subtree stops.

The dashboard provides:

- a virtualized, searchable parent/child tree;
- state, activity, model, thinking level, usage, duration, generation, and
  task summary;
- the selected task's live active-branch transcript and recent coordination
  feed;
- message and stop actions;
- arrow or `j`/`k` navigation, `/` search, and Page Up/Page Down transcript
  scrolling.

## Behaviour

- **Canonical identity.** `/root` is the root task. Each child adds one
  validated path segment.
- **Spawn configuration.** Each child receives its thinking level at spawn and
 keeps it for that run. Omission inherits the caller's current level.
- **Bounded direct fan-out.** A parent runs at most 12 direct children
  concurrently by default. Additional accepted tasks queue until a slot opens.
- **Hard coordination waits.** Parents remain suspended while descendants are
  active and wake only for mail, lifecycle changes, or user interruption.
- **Directional messages.** Downward messages are instructions. Upward messages
  are blocking questions. Completion and failure are runtime lifecycle events.
- **Nested approval.** Root decides every nested `spawn_agent` request through a
 structured `send_message` tool call before the child is created.
- **Resumable tasks.** Sending a message to a terminal task reopens the same
  isolated session. `restart_agent` also terminates an unresponsive active
  process and resumes that same session as a new result generation.
- **Result publication.** A result file is written atomically before completion
  mail is published.
- **Programmatic stall detection.** While root is blocked in `wait_agent`, a
 deadline-driven watchdog tracks transcript writes, token-bearing responses,
 streamed model output, and tool lifecycle updates for each active leaf task.
 After ten minutes without observable progress it wakes the main agent with
 exact telemetry. The main agent must then restart the persisted conversation
 in a fresh process or kill the stalled task; no separate overseer model is
 involved.

## Configuration

Environment variables:

- `PI_SUBAGENTS_DIR` — run storage base, default
  `~/.pi/agent/subagents`.
- `PI_SUBAGENTS_MAX_ACTIVE` — concurrent direct children per parent, default
  `12`.
- `PI_SUBAGENTS_STALL_TIMEOUT_MS` — maximum time without observable progress
  before the main agent is alerted, default `600000`.
- `PI_SUBAGENTS_RUN_TTL_MS` — completed-run retention before startup cleanup,
  default `86400000`.
- `PI_SUBAGENTS_FEED_TAIL` — recent dashboard feed rows, default `8`.

## Storage

```text
~/.pi/agent/subagents/<run>/run.json
~/.pi/agent/subagents/<run>/tasks/<hashed-task-path>/beacon.json
~/.pi/agent/subagents/<run>/tasks/<hashed-task-path>/children/
~/.pi/agent/subagents/<run>/tasks/<hashed-task-path>/inbox/
~/.pi/agent/subagents/<run>/tasks/<hashed-task-path>/launch.json
~/.pi/agent/subagents/<run>/results/
~/.pi/agent/subagents/<run>/sessions/
~/.pi/agent/subagents/<run>/feed.log
```

Child processes receive `PI_SUBAGENT_TASK_PATH`, `PI_SUBAGENT_PARENT_PATH`,
`PI_SUBAGENT_NOTIFY_PATH`, and `PI_SUBAGENT_RUN`. Their session identifiers
remain inside the run-local session directory.
