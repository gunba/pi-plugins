# pi-plugins

Custom Pi extensions packaged as one auto-updatable Pi package.

## Extensions

- `pi-codex-compat` — adds Codex-shaped `apply_patch`, `exec_command`,
  `write_stdin`, `view_image`, and `image_gen` tools for GPT-5.x/Codex models.
  The tool overlay activates only for Codex-like models and preserves unrelated
  tools. Text-only Codex models receive saved image artifacts and delegate visual
  inspection to an authenticated image-capable model for concise descriptions.
  `apply_patch` accepts Codex envelopes, moves, and structurally recognized
  heredoc bodies; environment IDs are rejected until Pi exposes real routing.
  Managed shell sessions stream partial output, terminate
  process trees, retain complete logs when display output is truncated, and use
  compact tool rendering while preserving context-mode HTTP-output guardrails.
  `view_image` emits Pi-native image blocks and normalises older session images
  before provider requests; `/repair-session-images` performs a backed-up
  permanent repair. `image_gen` follows OpenAI Codex's standalone image tool,
  generates or edits with `gpt-image-2`, and saves outputs under
  `$CODEX_HOME/generated_images`. A native footer status passively shows Codex
  5h/7d usage; `/pi-usage` shows the detailed token, cost, and rate-limit
  breakdown and controls that status.
- `pi-web-search` — adds one `web_search` tool, labelled `web.run`, based on
  Codex's standalone search client. It sends Codex-compatible commands directly
  to the selected ChatGPT Codex model's `alpha/search` endpoint. It has no
  provider router, fallback provider, summary workflow, or separately selected
  model.
- `pi-ask-user` — conservative local fork of `pi-ask-user@0.11.2` that
  provides the interactive `ask_user` tool without loading the upstream
  mandatory decision-gate skill by default.
- `pi-brief` — adds `/brief <task>` as an interactive intent-to-prompt workflow.
  The model renders a structured brief in chat, revises it from normal feedback,
  enforces an explicit process, time horizon, persistence and no-partial-work
  policies, writes the evolving prompt under `.pi/briefs/`, and replaces the
  current conversation with the approved brief.
- `pi-scheduler` — adds `/schedule <delay> <message>` and an agent-facing
  `schedule` tool for delayed messages (`15m`, `5h`, `5.5h`, `30d`) with a
  compact queued-message panel, countdowns, `ctrl+o` expansion, and
  cancel/list command reminders. Agents can cancel pending messages with
  `cancel_scheduled_message`. Due reminders appear as labelled scheduler
  messages instead of newly typed user messages. Agent-created messages steer
  an active run; user-created `/schedule` messages wait as follow-ups.
- `pi-extension-freshness` — prints a startup extension freshness panel with
  last-updated dates, age-based color coding, and `/extension-freshness` for
  on-demand review of stale extension paths.
- `pi-config` — adds `/pi-config` and `/pcfg` for Pi-native settings, context,
  skills, MCP, and subagent configuration.
- `pi-sync` — adds `/pi-sync` for synchronising `~/.pi` through a private
  git repository, with generated package installs, sessions, caches, tmp files,
  and local auth state kept machine-local.
- `pi-system-context` — adds compact local environment context to the system
  prompt.
- `pi-compaction-context` — carries the active `AGENTS.md` / `CLAUDE.md`
  context into Pi's compaction summariser so checkpoint summaries are written
  with the same project rules as normal turns.
- `pi-context-ledger` — prints a one-time, TUI-only breakdown of
  pre-conversation context (system prompt, skills, MCPs, tools, first message)
  after the first user message; never sent to the model.
- `pi-memedit` — automatically hard-deletes low-value conversation items from
  live context and the session log, including optional live continuation
  pruning during long runs; follows its global setting and is compatible with
  Anthropic OAuth prune calls.
- `pi-goal` — adds one durable, branch-local completion objective with `/goal`,
  `get_goal`, `create_goal`, and `update_goal`. Input-bound direct-human
  authority protects mutations; bounded same-session rounds use revision-fenced
  transitions and fail closed when Pi context cannot be authenticated.
- `pi-subagents` — provides DSH-style fresh and forked Pi SDK children through
  `subagent` and `subagent_fork`, plus FIFO `send_message`, current-turn
  `interrupt_agent`, durable discovery, child reporting, cold resumption and a
  live TUI dashboard. Background delegation returns immediately; report and
  settlement outboxes survive runtime replacement, busy-parent settlements steer
  the active turn, and enabled children retain the maintained `todo_write` tool.
- `pi-todo` — adds the whole-list `todo_write` tool and a compact standing task
  panel. Ordered immutable three-state snapshots are branch-aware, remain visible
  through settlement, and render model-supplied text without terminal controls.

## Install

### Opt-in transport comparison

[`pi-codex-wire`](pi-codex-wire/README.md) is a separate, disabled-by-default
workspace package. It keeps Pi's agent loop while reproducing the verified
Codex 0.147.0 transport and providing controlled client-identity comparisons.
The linked guide covers activation, privacy-safe diagnostics and testing.
It is not part of the automatic extension manifest.

### Standard extensions

```bash
pi install git:github.com/gunba/pi-plugins
```

Do not pin a ref if you want Pi startup/update checks to detect new commits.
Use:

```bash
pi update --extensions
```

or plain:

```bash
pi update
```

## Development

The package manifest at the repository root loads the extension files from the
`pi-*` subdirectories. Keep plugin directories and package names prefixed with
`pi-`.

Install the pinned development dependencies and run the same strict typecheck
and unit tests as CI:

```bash
npm ci
npm run check
```

The Pi packages remain optional runtime peers; their pinned development copies
make extension API changes visible to TypeScript before release.

The detailed Codex usage report derives its token breakdown from the per-message
`usage` Pi records (input / cacheRead / cacheWrite / output and matching
per-bucket cost). The native Pi footer remains intact; the extension contributes
only the passive Codex 5h/7d rate-limit status.

Codex plan-window tracking is passive: `x-codex-*` response headers and
`codex.rate_limits` WebSocket events update the persisted snapshot and status
countdowns during the conversation.

The root `.npmrc` prevents npm from auto-installing Pi peer dependencies when
Pi installs this git package; Pi provides those packages at runtime.
