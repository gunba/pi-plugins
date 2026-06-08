# pi-subagents — design

A primitive for running **background pi processes as a team**, watched and coordinated
from the main session.

A *subagent* is a fresh `pi`, given one task, run in the background with the same
installed capabilities as a native session — its own process, its own clean context,
no shared memory. Teams (competing hypotheses, division of labour) and inter-agent
conversation are *emergent* from one shared mailbox and three tools, not from a
catalogue of roles, an orchestration DSL, or a standing prompt block.

The design is deliberately small. The value is in the primitive and the coordination
surface, not in coverage.

---

## 1. Principles

- **Primitive over framework.** A subagent is `pi --print` in a child process. Nothing
  is forked, copied, or re-implemented; the OS already isolates processes.
- **Less is more.** Three tools (`spawn`, `message`, `wait`), one command
  (`/subagents`), no presets, no roles, no per-session context tax.
- **Teams are emergent.** Map-reduce, debate, judge, pipeline, competing hypotheses —
  all live in prompt-space over the same primitive. The code never grows to add a
  pattern.
- **Capabilities are inherited, not re-granted.** A subagent loads the same plugin
  stack as a native session. The differences fall out of *being headless*, not out of
  suppression.

## 2. The primitive

```
pi --print "<task>" --no-session --mode json
   --model <inherited>  --exclude-tools ask_user
   env: PI_SUBAGENT_RUN=<run-dir>  PI_SUBAGENT_NAME=Alice  PI_SUBAGENT_PARENT=main
```

- **Background.** `spawn` launches and returns immediately with the subagent's name
  and task name.
- **Out of `/resume`.** Each subagent's session lives in an isolated store
  (`--session-id <name> --session-dir <run>/sessions`) that `/resume` never scans — so
  subagents are resumable but never clutter the user's session list.
- **Self-cleaning, resumable.** A subagent runs only while working: on completion it pushes
  its result to its parent and exits, so there are no idle processes and the parent keeps
  no bookkeeping (a crash is surfaced the same way — a notice from the dead process).
  Messaging a finished agent resumes it from its own memory — identity and history persist,
  compute does not. Run directories from past sessions are swept on the next startup; an
  atomic `.active` lock keeps two callers from resuming the same agent at once.
- **Full capabilities.** Normal extension discovery; the child runs the same plugins.
- **Headless ⇒ no UI.** GUI/TUI behaviour no-ops because `ctx.hasUI` is false; `ask_user`
  is excluded because there is no user to reach. Plugins that require a UI (e.g. the
  context ledger) are naturally silent; plugins driven by global settings (e.g. memedit,
  lazy-skills) behave exactly as configured. No suppression handshake exists.

Child-mode is detected from `PI_SUBAGENT_RUN`/`PI_SUBAGENT_NAME`; the run directory is
the shared substrate for the whole tree at any depth.

## 3. Identity — name + task name

| Field | Source | Role |
|---|---|---|
| **name** | generic first-name pool (`Alice, Bob, Cara…`), unique per run | address + label |
| **task name** | provided by the spawning agent as a `spawn` argument | "what is this one for?" |

Surfaced together as `Alice · auth-race repro`. The spawning agent already knows what the
subagent is for, so it labels it — no naming model call.

## 4. Tools

| Tool | Purpose |
|---|---|
| `spawn` | start background subagent(s); returns name + task name. A nested spawn (by a non-root agent) asks the root main for approval first. |
| `message` | `to, body, reply_to?, wait?` — talk to any agent by name or to `main`; `wait:true` asks and blocks for the reply; `reply_to` answers a question. |
| `wait` | yield until an event (a question, an approval request, or a subagent reaching a terminal state). Always interruptible. |

Receiving is automatic: inbound messages surface as `wait` wake events, or are injected
at the next turn boundary for an agent that is actively working. There are no
status/result/stop/dismiss tools — completion arrives as a message, deliverables are
files, and stopping happens in the team view.

## 5. The responsive block

After spawning a team the main agent calls **`wait`** to yield. While parked it wakes
only on events; to answer a subagent it **may investigate with its full tools**, sends
the reply, then `wait`s again. The block is simply that main lives inside `wait` — there
is no tool-stripping, which is what lets main spawn several subagents before yielding and
investigate freely when answering. The practice (yield rather than pursue the team's
tasks in parallel) is carried by tool guidance, not enforced machinery.

```
spawn Alice ; spawn Bob ; spawn Cara      # set up the team (no block)
wait                                       # yield; team runs
  ← Bob asks "prod or stg DB?"             # wake; investigate if needed
  → message Bob "stg"                      # answer
wait                                       # yield again
  ← team complete, deliverables: [...]     # integrate
```

## 6. Intercom — one filesystem mailbox

Every node (main and every subagent, any depth) has an address and an inbox under the
run directory; a message is a small JSON file `{from, to, kind, body, id, ts}`. `message`
reaches **any agent or main** — agent↔agent included. The root main tails the whole run
directory and renders **all** traffic, including agent↔agent, in the main window via a
custom message renderer.

## 7. Expansion by approval

There is no depth counter. A nested `spawn` internally asks the root main for approval
(reusing the mailbox); it launches only if approved. The human sees the request in the
team view and can approve, deny, or override. Expansion costs a sign-off, so the tree
cannot run away — bounded by judgement rather than an arbitrary limit.

## 8. Stuck agents never brick the session

No agent-chosen timeouts and no main micromanaging. Instead:

- **`wait` is always interruptible** (abort signal + Esc), so control always returns.
- A **watchdog** notices a node with no progress for an interval and raises a UI prompt:
  *keep waiting · prod · stop*. Stopping makes the node terminal, which resolves any
  `wait` blocked on it.

The human is the circuit-breaker; nothing hangs the session.

## 9. Team view — `/subagents`

A live **company-structure** view: the root main at the top, children and grandchildren
below, one line per node showing `name · task name · state · activity · elapsed`, plus the
comms feed. Rendered as a live text widget that tails per-node beacon files and `feed.log`
under the run directory, so the whole graph at any depth is visible at a glance. Reached by
the `/subagents` command. States: `spawning · running · waiting · done · error · stopped`.

(pi's TUI is keyboard-driven and does not enable mouse reporting, so there is no clickable
button to surface; the command is the entry point.)

## 10. Guidance

Concise, attached to the tools (no standing system block):

> **[pi-subagents]** Subagents are background pi processes with your tools and no shared
> memory — brief each with one objective and its done criteria. Use them for independent
> parallel work (competing hypotheses, wide searches, parallel builds). After spawning
> your team, call `wait` and let them run rather than duplicating their work. They can't
> reach the user, so they ask you — investigate if needed, then reply. Nested subagents
> need your approval. A stuck subagent never blocks you: `wait` is interruptible and
> `/subagents` lets you prod or stop any node.

## 11. Layout & runtime

```
pi-subagents/extensions/subagents.ts     tools, mailbox, watchdog, team view
~/.pi/agent/subagents/<run>/<name>/      inbox/ · beacon.json   ·   <run>/feed.log
```

Settings live under `pi-config`'s existing `subagents` field: default model/scope,
concurrency, run-dir, watchdog interval.
