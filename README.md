# pi-plugins

Custom Pi extensions packaged as one auto-updatable Pi package. Requires Node.js 22.19+ and Pi 0.87.1+.

## Extensions

- `pi-codex-compat` — adds Codex-shaped `apply_patch`, `patch_and_run`, `exec_command`,
  `write_stdin`, `view_image`, and `image_gen` tools for GPT-5.x/Codex models.
  The tool overlay activates only for Codex-like models and preserves unrelated
  tools, except that active `apply_patch` replaces built-in `edit` so repeated
  text is handled with contextual hunks rather than text-rewrite scripts.
  Text-only Codex models receive saved image artifacts and delegate visual
  inspection to an authenticated image-capable model for concise descriptions.
  `apply_patch` accepts Codex envelopes, moves, and structurally recognized
  heredoc bodies, with native grammar input on supported models and cancellable,
  alias-safe file mutation. `patch_and_run` applies the same patch then starts a
  follow-up command only on success. Managed shell sessions launch independently, stream partial output, terminate
  process trees, retain complete logs when display output is truncated, and use
  compact tool rendering while preserving context-mode HTTP-output guardrails.
  `view_image` validates image data and emits Pi-native image blocks.
  `image_gen` follows OpenAI Codex's standalone image tool, generates or edits
  with GPT Image 2.5 Sunburst or Flare, and saves outputs under
  `$CODEX_HOME/generated_images`.
- [`pi-local-links`](pi-local-links/README.md) — resolves relative file hyperlinks
  in assistant Markdown against the session working directory, using absolute
  file URLs for terminal Ctrl+click. Applies during streaming and history
  restoration without changing saved messages or model context.
- [`pi-message-timestamps`](pi-message-timestamps/README.md) — shows compact
  time and duration inside tool blocks, plus a live elapsed/quiet clock while
  tools run. No new session entries or model context.
- [`pi-web-search`](pi-web-search/README.md) — adds one `web_search` tool, labelled `web.run`, based on
  Codex's standalone search client. It sends Codex-compatible commands directly
  to the selected ChatGPT Codex model's `alpha/search` endpoint. It has no
  provider router, fallback provider, summary workflow, or separately selected
  model. Native citation references render as readable terminal text without
  altering the model's source evidence.
- `pi-ask-user` — conservative local fork of `pi-ask-user@0.11.2` that
  provides the interactive `ask_user` tool without loading the upstream
  mandatory decision-gate skill by default.
- `pi-scheduler` — adds `/schedule <delay> <message>` and an agent-facing
  `schedule` tool for delayed messages (`15m`, `5h`, `5.5h`, `30d`) with a
  compact shared summary and full details in `/work scheduled`.
  `/schedule list` also opens this view. Agents can cancel pending messages with
  `cancel_scheduled_message`. Due reminders appear as labelled scheduler
  messages instead of newly typed user messages. Agent-created messages steer
  an active run, as do user-created reminders. Session-scoped SQLite transactions
  protect concurrent scheduling and delivery in live TUI and RPC sessions.
- `pi-config` — adds `/pi-config` and `/pcfg` for Pi-native settings, context,
  skills, and MCP configuration.
- `pi-system-context` — adds compact local environment context to the system
  prompt.
- `pi-compaction-context` — carries the active `AGENTS.md` / `CLAUDE.md`
  context into Pi's compaction summariser so checkpoint summaries are written
  with the same project rules as normal turns.
- [`pi-output-budget`](pi-output-budget/README.md) — bounded text previews,
  immutable complete-output artifacts, character paging, batched read-only
  file inspection, and compact replay links for older archived results.
  The same explicit policy is installed in SDK children;
  unrelated extension discovery remains disabled.
- `pi-session-memory` — bounds long-running Pi processes by releasing obsolete
  message, tool-result, image, and old-summary payloads from memory after
  compaction. The active context and current-branch extension state remain
  available, while the append-only JSONL session archive stays complete.
- `pi-fast-footer` — keeps interactive session usage and context statistics
  cached between session changes instead of scanning the full transcript on
  each terminal redraw. Git branch and extension status updates stay live.
- `pi-context-ledger` — prints a one-time, TUI-only breakdown of
  pre-conversation context (system prompt, skills, MCPs, tools, first message)
  after the first user message; never sent to the model.
- [`pi-context-window`](pi-context-window/README.md) — `/context-window`
  opens a modal for the active model's window and checkpoint setting, including
  an opt-in 1M/900K preset for supported OpenAI models.
- [`pi-party`](pi-party/README.md) — local agent discovery, self-managed parties,
  invitations and direct or group messaging, with message previews and a live
  `/party chat` conversation viewer.
- [`pi-browser`](pi-browser/README.md) — a focused browser skill for
  `@narumitw/pi-chrome-devtools`. Explicit page IDs route actions, scoped
  observations limit context, and full text uses the output archive.
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
- [`pi-work-ui`](pi-work-ui/README.md) — combines goal, todo, subagent, party and
  scheduled state above the editor. `/work` opens complete details in a modal;
  fullscreen summary clicks open the corresponding section. Management reuses
  the existing subagent and party screens. Native tool expansion remains separate.
  The shared UI loads with any consumer, not a separate manifest entry.

## Install

### Always-enabled Codex transport

[`pi-codex-wire`](pi-codex-wire/README.md) is included in the automatic extension
manifest and always activates in Codex mode. It keeps Pi's agent loop and offers
CLI or Desktop request identity through `/codex-wire client cli|desktop`.

Wire also owns the passive 5h/7d allowance status and `/pi-usage`. Recorded
token/API costs are separate from subscription allowance. Its shared usage
reducer includes native usage entries, billed tools, summaries, and
deduplicated child charges in both `/pi-usage` and the fast footer.
`/fast on|off|status` controls an off-by-default, paid ChatGPT Codex speed tier.
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
and Windows using the pinned Pi 0.87.1 dependencies on Node 22 and Node 24.
Codex Wire carries its own serializer dependency; this does not upgrade
the installed Pi application.

The detailed Codex usage report includes native assistant, tool, and summary
usage, plus durable background-child charges deduplicated by invocation ID.
Successful foreground children return native tool usage. The cached Pi footer
does not include custom background billing; the extension also
contributes the passive Codex 5h/7d rate-limit status.

Codex plan-window tracking is passive: `x-codex-*` response headers and
`codex.rate_limits` WebSocket events update the persisted snapshot and status
countdowns during the conversation.

The root `.npmrc` prevents npm from auto-installing Pi peer dependencies when
Pi installs this git package; Pi provides those packages at runtime.

## Context and request controls

`/context-window` opens a modal for the selected model. Pi's Codex catalog may
report 272,000 tokens even when an OpenAI model supports a larger window. The
opt-in 1M preset records a model-specific window and a 900K automatic
checkpoint threshold. `pi-codex-wire` supplies the native Codex checkpoint;
other running Pi processes pick up the selected settings after `/reload`.

Wire remains mandatory. Full-prompt prewarming is **off by default** and can be
changed independently with `/codex-wire prewarm on|off`. Provider replacement or
failed reactivation cannot silently route Codex work through the stock provider.
The SDK child adapter inherits Wire rather than rediscovering all extensions.

`exec_command` selects an explicit `shell`, then Pi's trusted `shellPath` setting,
then Pi's platform shell discovery. It no longer selects Windows CMD merely
because `ComSpec` exists.

`wait_for_work` yields to registered child, process or timer completion events
without repeated model polling. It must name existing session-owned resources;
it does not infer waiting from prose or suspend independent useful work.

Use `node pi-codex-wire/ledger.mjs <run.jsonl> [...]` to group provider-reported
usage by root/child session, request purpose and origin. Request attempts,
prewarms, summaries and allowance observations remain separate; decoder usage is
not added again. These records do not establish a subscription charging formula.
