# pi-subagents

Run delegated work in isolated background `pi` processes. Each task has a
canonical path under `/root`, a clean context, a shared working directory, and
a resumable Pi session.

## Tools

- `spawn_agent(task_name, message, thinking?)` starts a direct child at
  `<caller-path>/<task_name>`. It is only for a genuinely new objective and
  creates a new task identity and conversation.
- `send_message(target, message)` sends a short message. Downward messages
  instruct a live child or resume a terminal child in its persisted
  conversation; upward messages wait for the ancestor's answer. Corrections,
  follow-ups, and retries use this tool against the original task path.
- `restart_agent(target, message)` replaces an unresponsive active process and
  resumes its persisted conversation with a recovery instruction.
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
  structured `send_message` tool call before the child is created. Replacement
  work is denied and resumed at its existing task path instead.
- **Resumable tasks.** Sending a message to a terminal task reopens the same
  isolated session. `restart_agent` also terminates an unresponsive active
  process and resumes that same session as a new result generation. Running and
  completed descendant state, pending requests, mail, queues, and result files
  are reconstructed from run storage; replacing a parent process does not stop
  its children. If parent recovery is ultimately exhausted, later descendant
  mail is forwarded to the nearest live ancestor rather than orphaned.
- **Automatic error recovery.** After Pi exhausts its built-in retries, a child
  sends `Continue` up to twice in the same process. If both attempts error, the
  launcher resumes the same persisted session once in a fresh process with
  `Continue`. Any successful assistant message resets this recovery budget.
- **Fatal-result salvage.** If the fresh process produces no successful response,
  one final fresh process reviews the same conversation and returns a concise
  best-effort result for the original task. A parent with unfinished descendants
  reconnects to them with read-only coordination tools before summarizing. The
  parent is notified only when that summary completes or also fails.
- **Result publication.** A result file is written atomically before completion
  mail is published. Its answer is selected from the persisted active session
  branch, so a trailing extension-notification acknowledgement cannot replace
  an earlier completed task answer.
- **Programmatic stall detection.** While root is blocked in `wait_agent`, a
  deadline-driven watchdog tracks transcript writes, token-bearing responses,
  streamed model output, and tool lifecycle updates for every active,
  non-waiting task. This includes a stalled parent whose children are still
  running. After ten minutes without observable progress it advances through
  the same fresh-process restart and fatal-result summary stages automatically.
  The main agent is woken only when a final result or unrecoverable failure is
  available; no separate overseer model is involved.

## Configuration

Environment variables:

- `PI_SUBAGENTS_DIR` — run storage base, default
  `~/.pi/agent/subagents`.
- `PI_SUBAGENTS_MAX_ACTIVE` — concurrent direct children per parent, default
  `12`.
- `PI_SUBAGENTS_STALL_TIMEOUT_MS` — maximum time without observable progress
  before automatic recovery advances, default `600000`.
- `PI_SUBAGENTS_RUN_TTL_MS` — completed-run retention before startup cleanup,
  default `86400000`.
- `PI_SUBAGENTS_FEED_TAIL` — recent dashboard feed rows, default `8`.

## Storage

```text
~/.pi/agent/subagents/<run>/run.json
~/.pi/agent/subagents/<run>/tasks/<hashed-task-path>/beacon.json
~/.pi/agent/subagents/<run>/tasks/<hashed-task-path>/children/
~/.pi/agent/subagents/<run>/tasks/<hashed-task-path>/inbox/
~/.pi/agent/subagents/<run>/tasks/<hashed-task-path>/pending-request.json
~/.pi/agent/subagents/<run>/tasks/<hashed-task-path>/launch.json
~/.pi/agent/subagents/<run>/results/
~/.pi/agent/subagents/<run>/sessions/
~/.pi/agent/subagents/<run>/feed.log
```

Child processes receive `PI_SUBAGENT_TASK_PATH`, `PI_SUBAGENT_PARENT_PATH`,
`PI_SUBAGENT_NOTIFY_PATH`, and `PI_SUBAGENT_RUN`. Their session identifiers
remain inside the run-local session directory.
