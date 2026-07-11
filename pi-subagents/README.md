# pi-subagents

Run delegated work in isolated background `pi` processes through a Codex V2-shaped collaboration surface. Each task has a canonical path under `/root`, a clean model context, the normal installed plugin stack, a shared working directory, and a resumable Pi session.

## Tools

- `spawn_agent(task_name, message)` creates a direct child at `<caller-path>/<task_name>`. Task names use lowercase ASCII letters, digits, and underscores.
- `send_message(target, message, reply_to?)` stores cooperative mail independently of turn activation. Use `reply_to` for correlated request responses.
- `followup_task(target, message)` starts or queues a new turn in an existing task's saved session.
- `wait_agent(timeout_ms?)` waits for mailbox activity, child lifecycle changes, user steering, or a timeout. The default is 30 seconds; accepted values are 10 seconds through one hour.
- `interrupt_agent(target)` gracefully interrupts the current turn while preserving the task's resumable session.
- `list_agents(path_prefix?)` returns canonical task paths, Codex-shaped statuses, and the latest task summary.
- `inspect_agent(target)` lets `/root` read any descendant's active session branch, including messages, reasoning, tool calls/results, provider errors, compactions, and model changes.
- `control_agent(target, action, message?, thinking?)` lets `/root` steer any descendant or change its Pi thinking level.

Targets may be canonical `/root/...` paths or paths relative to the caller. `/root` can address the entire tree; child agents can coordinate with `/root`, their parent, and their own subtree.

The normal orchestration loop is `spawn_agent` → `wait_agent` → coordinate with `send_message`, `followup_task`, `interrupt_agent`, `inspect_agent`, or `control_agent` → `wait_agent`. Completion mail keeps the parent context compact by pointing to a result file.

## Orchestration dashboard

A compact line above the editor shows active, queued, completed, and attention-needed counts. `/subagents` opens a full-terminal overlay; `/subagents <task-path>` opens it on one task. `/subagent` is an equivalent singular command and supports inline messages and emergency hard termination.

The dashboard provides:

- a virtualized, searchable parent/child tree keyed by canonical task path;
- state, current activity, model, thinking level, usage, duration, generation, and task summary;
- the selected task's live active-branch session tail and recent coordination feed;
- direct actions for cooperative messages, steering, follow-up turns, thinking changes, graceful interruption, and confirmed emergency hard termination;
- arrow or `j`/`k` navigation, `/` search, and Page Up/Page Down transcript scrolling.

## Behaviour

- **Canonical identity.** `/root` is the root task. Each child adds one validated segment, so nested work has stable paths such as `/root/research/history`.
- **Bounded direct fan-out.** A parent runs at most 12 direct children concurrently by default. Additional accepted tasks remain visible as `pending_init` and launch as slots free.
- **Event-driven coordination.** Parents watch their inbox and direct children. `wait_agent` also has a bounded timeout and responds to user steering.
- **Atomic state.** Beacon replacement, path reservation, and mailbox claims are atomic. Replies are correlated with their expected sender.
- **Root coordination gate.** While descendants are active or child mail is unread, the parent remains a coordinator. Collaboration tools handle normal coordination; a claimed child request may use the tools needed to prepare its response. `/root` retains direct inspection and control at every depth.
- **Live control.** Running children watch a dedicated control inbox for steering, follow-up turns, interruption, and thinking changes.
- **Nested approval.** A nested `spawn_agent` asks `/root` for deliberate approval. Set `subagents.nestedSpawnApproval` to `user` to route requests through a confirmation modal.
- **Resumable tasks.** `followup_task` reopens the same isolated Pi session at the same canonical path and records a new result generation.
- **Result publication.** A result file is written atomically before completion mail is published. Completion uses a `FINAL_ANSWER` envelope containing the sender path, parent task path, status, and file path.
- **Lifecycle safety.** A parent remains in coordination while descendants or unread child mail exist. Graceful interruption preserves the session; dashboard, watchdog, and shutdown paths provide confirmed emergency process termination.
- **Deep watchdog.** The root watchdog can identify and stop a non-coordinating descendant. Queued, waiting, and parent agents with live children are not treated as stuck.
- **Settled completion.** Results publish only after Pi emits `agent_settled`, so automatic retry, compaction retry, and queued follow-ups finish first.

## Configuration

Environment variables:

- `PI_SUBAGENTS_DIR` — run storage base, default `~/.pi/agent/subagents`.
- `PI_SUBAGENTS_MAX_ACTIVE` — concurrent direct children per parent, default `12`.
- `PI_SUBAGENTS_STALE_MS` — watchdog threshold outside a tool call, default `600000`.
- `PI_SUBAGENTS_ACTIVE_TOOL_STALE_MS` — watchdog threshold during a tool call, default `1800000`.
- `PI_SUBAGENTS_RUN_TTL_MS` — completed-run retention before startup cleanup, default `86400000`.
- `PI_SUBAGENTS_FEED_TAIL` — recent dashboard feed rows, default `8`.
- `PI_SUBAGENTS_NESTED_SPAWN_APPROVAL` — `agent` or `user`.

Nested approval can also be configured globally in `~/.pi/agent/settings.json` or per trusted project in `.pi/settings.json`:

```json
{
  "subagents": {
    "nestedSpawnApproval": "user"
  }
}
```

## Storage

```text
~/.pi/agent/subagents/<run>/run.json
~/.pi/agent/subagents/<run>/tasks/<hashed-task-path>/beacon.json
~/.pi/agent/subagents/<run>/tasks/<hashed-task-path>/children/
~/.pi/agent/subagents/<run>/tasks/<hashed-task-path>/inbox/
~/.pi/agent/subagents/<run>/tasks/<hashed-task-path>/control/
~/.pi/agent/subagents/<run>/tasks/<hashed-task-path>/launch.json
~/.pi/agent/subagents/<run>/results/
~/.pi/agent/subagents/<run>/sessions/
~/.pi/agent/subagents/<run>/feed.log
```

Child processes receive `PI_SUBAGENT_TASK_PATH`, `PI_SUBAGENT_PARENT_PATH`, `PI_SUBAGENT_NOTIFY_PATH`, and `PI_SUBAGENT_RUN`. Their opaque session identifiers remain inside the run-local session directory and resume through `followup_task`.
