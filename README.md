# pi-plugins

Custom Pi extensions packaged as one auto-updatable Pi package.

## Extensions

- `pi-fixes` — bundled workarounds for upstream Pi issues, with built-in
  effectiveness tracking. Covers the oversized single-message guard before
  provider requests and tool-call continuations (`/context-guard`) and the
  Claude effort lift. `/pi-fixes` reports whether each fix is still firing
  (last 7d/30d, last seen, NEEDED/REVIEW/UNUSED verdict) so a workaround can
  be retired once its failure stops occurring.
- `pi-codex-compat` — adds Codex-shaped `apply_patch`, `shell_command`,
  `write_stdin`, and `view_image` tools for GPT-5.x/Codex models.
  `apply_patch` accepts the Codex patch envelope, optional environment
  preambles, moves, and heredoc bodies; `shell_command` maps Codex-style
  command/workdir/timeout fields onto Pi's bash backend while preserving
  context-mode HTTP-output guardrails, and can return resumable sessions for
  `write_stdin` when `yield_time_ms` is used. `view_image` emits Pi-native image
  blocks and normalises image results written by older releases before provider
  requests, including when sessions are resumed. `/repair-session-images`
  creates a backup and permanently rewrites those blocks in the current session.
- `pi-file-links` — turns project-relative paths, absolute Linux paths, tilde
  paths, Windows paths, UNC paths, and existing paths with spaces into
  clickable terminal file links while stripping generated links before model
  context.
- `pi-ask-user` — conservative local fork of `pi-ask-user@0.11.2` that
  provides the interactive `ask_user` tool without loading the upstream
  mandatory decision-gate skill by default.
- `pi-scheduler` — adds `/schedule <delay> <message>` and an agent-facing
  `schedule` tool for delayed messages (`15m`, `5h`, `5.5h`, `30d`) with a
  compact queued-message panel, countdowns, `ctrl+o` expansion, and
  cancel/list command reminders.
- `pi-usage` — passively shows Codex and Claude 5h/7d usage and reset timers
  in a compact two-line footer, plus a cumulative conversation token/cost
  breakdown (uncached input, cached input with hit rate, output, and total
  `$`) on the stats line; `/pi-usage` prints the full per-bucket token and
  cost attribution for the current model.
- `pi-extension-freshness` — prints a startup extension freshness panel with
  last-updated dates, age-based color coding, and `/extension-freshness` for
  on-demand review of stale extension paths.
- `pi-config` — adds `/pi-config` and `/pcfg` for Pi-native settings, context,
  skills, MCP, and subagent configuration.
- `pi-session-search` — adds `/session-search`, an exact-match modal for
  finding and resuming saved Pi sessions with snippets, all/current-cwd scope
  switching, regex, quoted phrases, date/path/name filters, a cached session
  index, and `Ctrl+A` background agent hunts for vague natural-language asks.
- `pi-sync` — adds `/pi-sync` for synchronising `~/.pi` through a private
  git repository, with generated package installs, sessions, caches, tmp files,
  and local auth state kept machine-local.
- `pi-tab-title` — auto-names terminal tabs from the first user message and
  shows fresh/thinking/ready/error state in the tab title.
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
- `pi-subagents` — runs background `pi` subagents as a coordinated team.
  `spawn` starts a named subagent on a task; `message`/`wait` provide a live
  intercom (agent↔agent and agent↔main); nested spawns are approval-gated by
  the main agent by default, or by a user confirmation modal when
  `subagents.nestedSpawnApproval` is `user`; and a styled, on-by-default
  `/subagents` team view shows the live tree. Subagents inherit the full plugin
  stack, run headless, resume from their own memory when re-addressed, and stay
  out of `/resume`.

## Install

```bash
pi install git:github.com/gunba/pi-plugins
```

## Web Search

Use `npm:pi-web-access` for web search, content fetching, GitHub repository
cloning, PDFs, and video extraction. Configure it to use Perplexity in
`~/.pi/web-search.json`:

```json
{
  "perplexityApiKey": "pplx-...",
  "provider": "perplexity",
  "searchProvider": "perplexity",
  "perplexityModel": "sonar"
}
```

Keep the API key in the local user config file, not in this repository.

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

The footer stats line derives its token breakdown from the per-message `usage`
Pi already records (input / cacheRead / cacheWrite / output and matching
per-bucket cost), which is normalised identically for Codex and Claude, so
cached vs uncached input and spend are exact for both — no tokenizer estimation
required.

`pi-usage` does not poll any usage endpoints. It updates from data already
returned by provider requests — Codex `x-codex-*` headers and
`codex.rate_limits` WebSocket events, and Claude
`anthropic-ratelimit-unified-*` headers (sent when Pi uses an Anthropic
OAuth/Claude Code subscription) — persists the latest snapshot per provider
locally, and refreshes countdown/session footer rendering during the
conversation. The footer shows whichever provider was used most recently.

The root `.npmrc` prevents npm from auto-installing Pi peer dependencies when
Pi installs this git package; Pi provides those packages at runtime.
