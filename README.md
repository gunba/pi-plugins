# pi-plugins

Custom Pi extensions packaged as one auto-updatable Pi package. Requires Node.js 22.19+ and Pi 1.0+.

## Pi Desk

[`pi-desk`](pi-desk/README.md) is the optional desktop and phone app. It runs Pi
sessions on their owning computers and presents them through one shared web
interface. An HTTPS relay provides remote access without inbound PC ports.
The included `/desk` extension prepares isolated runtimes with a pinned Pi SDK,
and manages updates, restart and login-start through native Pi dialogs.
The host build is optional; ordinary extension loading does not install its
frontend/server dependencies. See its [capability map](pi-desk/CAPABILITIES.md) and
[installation guide](pi-desk/UPDATING.md) for coverage and release boundaries.

## Extensions

- [`pi-local-links`](pi-local-links/README.md) — resolves relative file hyperlinks
  in assistant Markdown against the session working directory, using absolute
  file URLs for terminal Ctrl+click. Applies during streaming and history
  restoration without changing saved messages or model context.
- [`pi-message-timestamps`](pi-message-timestamps/README.md) — shows compact
  native timing in Desk and a live elapsed/quiet clock in the terminal.
  Tool timing metadata survives saved history without private renderer patches.
- [`pi-web-search`](pi-web-search/README.md) — adds one `web_search` tool, labelled `web.run`, based on
  Codex's standalone search client. It sends Codex-compatible commands directly
  to the selected ChatGPT Codex model's `alpha/search` endpoint. It has no
  provider router, fallback provider, summary workflow, or separately selected
  model. Native citation references render as readable terminal text without
  altering the model's source evidence.
- [`@gotgenes/pi-anthropic-auth`](https://github.com/gotgenes/pi-anthropic-auth) — pinned native
  Claude OAuth compatibility, including request identity and prompt shaping for
  root sessions, inherited child providers and compaction. Uses Pi's account
  storage and transport; no Claude Code process wrapper.
- `pi-ask-user` — conservative local fork of `pi-ask-user@0.11.2` that
  provides the interactive `ask_user` tool without loading the upstream
  mandatory decision-gate skill by default.
- `pi-config` — adds `/pi-config` and `/pcfg` for Pi-native settings, context,
  skills, and MCP configuration.
- `pi-system-context` — adds compact local environment context to the system
  prompt.
- `pi-compaction-context` — carries the active `AGENTS.md` / `CLAUDE.md`
  context into Pi's compaction summariser so checkpoint summaries are written
  with the same project rules as normal turns.
- [`pi-command-guard`](pi-command-guard/README.md) — in-process drive/Git wipe protection, exact-call confirmations and inherited SDK-child policy.
- [`pi-output-budget`](pi-output-budget/README.md) — tool results cut once to
  16,000 characters (where Pi's own tools cut theirs), immutable complete-output
  artifacts, character paging, images read at most 1.5 MB each, and compact
  replay links for older archived results.
  The same explicit policy is installed in SDK children;
  unrelated extension discovery remains disabled.
- `pi-session-memory` — bounds long-running Pi processes by releasing obsolete
  message, tool-result, image, and old-summary payloads from memory after
  compaction. The active context and current-branch extension state remain
  available, while the append-only JSONL session archive stays complete.
- `pi-fast-footer` — keeps interactive session usage and context statistics
  cached between session changes instead of scanning the full transcript on
  each terminal redraw. Git branch and extension status updates stay live.
- `pi-context-ledger` — shows a saved breakdown of
  pre-conversation context (system prompt, skills, MCPs, tools, first message)
  after the first user message in the terminal; never sent to the model.
- [`pi-context-window`](pi-context-window/README.md) — `/context-window`
  opens a modal for the active model's window and checkpoint setting, including
  an opt-in 1M/900K preset for supported OpenAI models.
- [`pi-agents`](pi-agents/README.md) — `agent_start`, `agent_send`, `agent_list`,
  `agent_stop` and `agent_move` for two kinds of agents: primary agents are
  conversations in Jordan's Desk on any of his computers, which he can open and
  talk to; secondary agents are background helpers that report back, waking an
  idle parent. Also Jordan's quest log and an `/inbox` viewer.
- [`pi-watch`](pi-watch/README.md) — `watch` waits without spending turns: a
  background command's output and end, a re-run command's changes, or a time,
  filtered by a classifier when asked. Watches survive restarts.
- [`pi-improve-skill`](pi-improve-skill/skills/improve-skill/SKILL.md) — improves a skill
  against benchmark cases: one strong-model session runs task-model trials, has task-model
  investigators explain each run, edits the skill and checks held-out cases.
- [`pi-code-review`](pi-code-review/README.md) — a code-review skill built from
  34,871 review comments in 35 top-tier projects (GitHub, kernel mailing lists,
  Go Gerrit), labelled with Jev, plus the mining pipeline and a held-out
  benchmark.
- [`pi-code-craft`](pi-code-craft/README.md) — test-writing and code-comments
  skills built from 26,000 review remarks on tests and comments in 64 projects,
  including changes written by coding agents, labelled with Jev, plus the mining
  pipeline and a held-out test-writing benchmark.
- [`pi-system-one`](pi-system-one/README.md) — one system-prompt paragraph on
  when to use System One classifier models such as TypeSafe's Jev through
  codemode's `models.classify`.
- [`pi-browser`](pi-browser/README.md) — a focused browser skill for
  `@narumitw/pi-chrome-devtools`. Explicit page IDs route actions, scoped
  observations limit context, and full text uses the output archive.
- [`pi-plan`](pi-plan/README.md) — one branch-local objective and checklist,
  with optional bounded automatic continuation. `/plan`, `get_plan`,
  `create_plan` and `update_plan` share the same revision-fenced native state.
  Manual plans never start extra model rounds.
- [`pi-show`](pi-show/README.md) — agents show their work in Pi Desk. Files a
  call changes get computed diffs: lines for text, cells for spreadsheets,
  paragraphs for Word documents and slides for decks, from the files
  themselves. The `show` tool presents results, previews and changes at key
  moments, and flags changed cells the agent did not mention.
- [`pi-work-ui`](pi-work-ui/README.md) — combines plan, subagent, party and
  scheduled state above the editor. `/work` opens complete details in a modal;
  fullscreen summary clicks open the corresponding section. Management reuses
  the existing subagent and party screens. Native tool expansion remains separate.
  The shared UI loads with any consumer, not a separate manifest entry.
- [`pi-session-ownership`](pi-session-ownership/README.md) — cooperative writer
  leases for native sessions. Desk acquires its lease before opening a session;
  terminal enforcement starts when its extension loads.

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

Install the pinned development dependencies:

```bash
npm ci
npm --prefix pi-desk ci --ignore-scripts
```

Use the focused commands in [AGENTS.md](AGENTS.md) for normal development.
Full integration/release validation is `npm run check`,
`npm --prefix pi-desk run typecheck`, and `npm --prefix pi-desk run build`.

The Pi packages remain optional runtime peers; their pinned development copies
make extension API changes visible to TypeScript before release. Main pushes run
Linux/Node 22 and Windows/Node 24 CI using pinned Pi 1.0 dependencies.
Manual `workflow_dispatch` runs all four OS/Node combinations; feature pushes and
pull requests do not trigger CI. Native Desk packaging remains release-tag-only.
Codex Wire resolves serializers from the host's Pi SDK; installing this package
does not upgrade the installed Pi application.

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

There is no waiting tool. Reports from secondary agents wake the conversation that
started them; background commands and timed wake-ups use `watch`.
