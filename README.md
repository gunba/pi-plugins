# pi-plugins

Custom Pi extensions packaged as one auto-updatable Pi package. Requires Node.js 22.19+ and Pi 0.84.3+.

## Extensions

- `pi-codex-compat` — adds Codex-shaped `apply_patch`, `exec_command`,
  `write_stdin`, `view_image`, and `image_gen` tools for GPT-5.x/Codex models.
  The tool overlay activates only for Codex-like models and preserves unrelated
  tools, except that active `apply_patch` replaces built-in `edit` so repeated
  text is handled with contextual hunks rather than text-rewrite scripts.
  Text-only Codex models receive saved image artifacts and delegate visual
  inspection to an authenticated image-capable model for concise descriptions.
  `apply_patch` accepts Codex envelopes, moves, and structurally recognized
  heredoc bodies, with native grammar input on supported models and cancellable,
  alias-safe file mutation. Managed shell sessions launch independently, stream partial output, terminate
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
  an active run, as do user-created reminders. Session-scoped SQLite transactions
  protect concurrent scheduling and delivery in live TUI and RPC sessions.
- `pi-extension-freshness` — prints a startup extension freshness panel with
  last-updated dates, age-based color coding, and `/extension-freshness` for
  on-demand review of stale extension paths.
- `pi-config` — adds `/pi-config` and `/pcfg` for Pi-native settings, context,
  skills, and MCP configuration.
- `pi-sync` — adds `/pi-sync` for synchronising `~/.pi` through a private
  git repository, with generated package installs, sessions, caches, tmp files,
  and local auth state kept machine-local.
- `pi-system-context` — adds compact local environment context to the system
  prompt.
- `pi-compaction-context` — carries the active `AGENTS.md` / `CLAUDE.md`
  context into Pi's compaction summariser so checkpoint summaries are written
  with the same project rules as normal turns.
- `pi-session-memory` — bounds long-running Pi processes by releasing obsolete
  message, tool-result, image, and old-summary payloads from memory after
  compaction. The active context and current-branch extension state remain
  available, while the append-only JSONL session archive stays complete.
- `pi-context-ledger` — prints a one-time, TUI-only breakdown of
  pre-conversation context (system prompt, skills, MCPs, tools, first message)
  after the first user message; never sent to the model.
- `pi-goal` — adds one durable, branch-local completion objective with `/goal`,
  `get_goal`, `create_goal`, and `update_goal`. Input-bound direct-human
  authority protects mutations; bounded same-session rounds use revision-fenced
  transitions and fail closed when Pi context cannot be authenticated.
- `pi-subagents` — provides DSH-style fresh and forked Pi SDK children through
  `subagent` and `subagent_fork`, steering `send_message`, FIFO `followup_task`,
  current-turn interruption, durable discovery, cold resumption, and a live TUI
  dashboard. Reports and settlements steer at every depth; late results may wake
  an idle parent. Children inherit effective project trust and authentication,
  with bounded depth, root-wide admission, and cancellable initialization.
  Optional model and thinking overrides require one user approval for the root
  conversation; descendants share that approval. `/subagents permissions`
  shows its status, and `/subagents permissions revoke` revokes future overrides.
- `pi-todo` — adds the whole-list `todo_write` tool and a compact standing task
  panel. Ordered immutable three-state snapshots are branch-aware, remain visible
  through settlement, and render model-supplied text without terminal controls.

## Install

### Always-enabled Codex transport

[`pi-codex-wire`](pi-codex-wire/README.md) is included in the automatic extension
manifest and always activates in Codex mode. It keeps Pi's agent loop and offers
CLI or Desktop request identity through `/codex-wire client cli|desktop`.
No separate package registration or saved activation setting is needed. Remove
any old standalone Wire registration to avoid loading it twice. The linked guide
covers identity limits, privacy-safe diagnostics and testing.

### Standard extensions

```bash
pi install git:github.com/gunba/pi-plugins
```

Do not pin a ref if you want Pi startup/update checks to detect new commits.
Use:

```bash
pi update --extensions
```

Plain `pi update` updates Pi itself. Use `pi update --extensions` for these
packages, or `pi update --all` to update both.

## Development

The package manifest at the repository root loads the extension files from the
`pi-*` subdirectories. Keep plugin directories and package names prefixed with
`pi-`.

Install the pinned development dependencies and run the same strict typecheck
and all discovered regression tests as CI:

```bash
npm ci
npm run check
```

The Pi packages remain optional runtime peers; their pinned development copies
make extension API changes visible to TypeScript before release. CI covers Linux
and Windows using Pi 0.84.3, 0.84.4, and 0.85.1 on Node 22, plus Pi 0.85.1 on
Node 24. Codex Wire carries its own serializer dependency; this does not upgrade
the installed Pi application.

The detailed Codex usage report includes native assistant, tool, and summary
usage, plus durable background-child charges deduplicated by invocation ID.
Successful foreground children return native tool usage. The native Pi footer
remains intact and does not include custom background billing; the extension also
contributes the passive Codex 5h/7d rate-limit status.

Codex plan-window tracking is passive: `x-codex-*` response headers and
`codex.rate_limits` WebSocket events update the persisted snapshot and status
countdowns during the conversation.

The root `.npmrc` prevents npm from auto-installing Pi peer dependencies when
Pi installs this git package; Pi provides those packages at runtime.
