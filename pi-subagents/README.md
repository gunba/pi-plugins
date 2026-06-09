# pi-subagents

Run background `pi` processes as a coordinated team. A *subagent* is a fresh `pi` given one task, launched headless in its own process with the same installed plugin stack as a normal session — its own clean context, no shared memory. Teams (competing hypotheses, division of labour, pipelines) and inter-agent conversation are emergent from three tools and one shared filesystem mailbox, not from a catalogue of roles or an orchestration DSL.

## Tools

- `spawn(task, name)` — start a background subagent on one task and return immediately with its assigned name. `task` is the full brief (the subagent starts cold); `name` is a short label shown in the team view. A nested spawn (by a subagent rather than `main`) first asks `main` for approval and only launches if approved.
- `message(to, body, reply_to?, wait?)` — send a message to any agent by name or to `main` (agent↔agent included). `wait:true` blocks for the reply; `reply_to` answers a question by its id. Messaging an agent that has finished resumes it from its own memory with the message as a follow-up task.
- `wait()` — yield until a subagent needs you (a question or approval request) or one finishes. It returns immediately if there is no active child subagent and no pending child message, so `wait` cannot deadlock an idle parent.

The usual loop: `spawn` a team, call `wait` to yield while they run, answer questions with `message`, then `wait` again. While an agent has active children or unread child messages, pi-subagents enforces that coordination loop: it may `spawn` more team members, `message` children, or `wait`, but not continue independent work. During a child request or repair event returned by `wait`, it can use normal tools, then it must reply/resume with `message` and return to `wait`. A subagent's final answer is never inlined into the wait result; completion returns a result-file path, and the parent reads that file only when it chooses to spend context on it.

## Team view — `/subagents`

A styled panel above the editor shows a colour-coded tree of the run — children and grandchildren under `main` — each row showing `glyph name · task  state  activity` with right-aligned progress (`responses`, token usage, latest context size, cost) and duration. The duration ticks while an agent works and freezes when it finishes. A `feed` section tails inter-agent traffic. States: `spawning · running · waiting · done · error · stopped`.

The view is **on by default and persisted**. `/subagents` toggles it and saves the choice. It appears whenever the run has subagents and hides when the run is empty.

## Behaviour

- **Full capabilities, headless.** A subagent loads the same plugins as a native session. Differences fall out of being headless: UI-only behaviour no-ops because there is no UI, and `ask_user` is excluded because there is no user to reach.
- **Nested spawns are gated.** There is no depth limit. A subagent's `spawn` posts an approval request to `main`; the human sees it in the team view and approves or denies. Expansion costs a sign-off, so the tree can't run away.
- **Self-cleaning and resumable.** A subagent runs only while working: on completion it writes its full final answer to `<run>/results/*.md`, sends only the result-file path to its parent, and exits, so there are no idle processes and no forced context dump. If the model turn ends with an error/abort, the agent is marked `stopped` with a needs-attention notice rather than `done`; the parent can read the result file and resume the same agent with `message`. Re-addressing a finished, attention-needed, or stopped agent with `message` resumes its session — identity and history persist, compute does not. An atomic `.active` lock stops two callers resuming the same agent at once.
- **Out of `/resume`.** Each subagent's session lives in an isolated store (`--session-id <name> --session-dir <run>/sessions`) that `/resume` never scans, so subagents are resumable but never clutter your session list.
- **Stuck agents never brick the session.** No agent-chosen timeouts. A watchdog notices a direct child doing its own work with no progress for an interval and raises a UI prompt to stop it; coordinating/waiting agents and agents with live children are not considered stuck. Stopping makes the node terminal and posts a repair event to the parent. `wait` also refuses to block when there are no active children or pending messages. The human is the circuit-breaker.

## Environment

- `PI_SUBAGENTS_DIR` — base directory for all runs (default `~/.pi/agent/subagents`).
- `PI_SUBAGENTS_SETTINGS` — path to the view-toggle settings file (default `<base>/settings.json`).
- `PI_SUBAGENTS_STALE_MS` — watchdog "no progress" threshold before prompting (default `120000`).
- `PI_SUBAGENTS_RUN_TTL_MS` — run directories older than this are swept on startup (default `86400000`, 24h).

Child processes are marked by the environment variables the parent sets on them — `PI_SUBAGENT_NAME` (the subagent's name; its presence is what flags a process as a subagent), `PI_SUBAGENT_PARENT` (the parent's name), and `PI_SUBAGENT_RUN` (the shared run directory for the whole tree).

## Layout

```
pi-subagents/extensions/subagents.ts        tools, mailbox, watchdog, team view
~/.pi/agent/subagents/settings.json         persisted /subagents toggle
~/.pi/agent/subagents/<run>/<name>/         beacon.json · inbox/ · .active lock
~/.pi/agent/subagents/<run>/results/        full subagent completion files returned by path
~/.pi/agent/subagents/<run>/sessions/       isolated session store (off /resume)
~/.pi/agent/subagents/<run>/feed.log        inter-agent message feed
```

Each agent has a name from a generic pool (`Alice, Bob, Cara…`), unique per run, surfaced with its task label as `Alice · auth-race repro`. Coordination is entirely the run directory: a `beacon.json` per agent for state, a JSON file per message in the recipient's `inbox/`, and `feed.log` for the team view.
