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
  `write_stdin`, `view_image`, and `image_gen` tools for GPT-5.x/Codex models.
  The tool overlay activates only for Codex-like models and preserves unrelated
  tools. Text-only Codex models receive saved image artifacts and delegate visual
  inspection to an authenticated image-capable model for concise descriptions.
  `apply_patch` accepts Codex envelopes, optional environment preambles, moves,
  and heredoc bodies. Managed shell sessions stream partial output, terminate
  process trees, retain complete logs when display output is truncated, and use
  compact tool rendering while preserving context-mode HTTP-output guardrails.
  `view_image` emits Pi-native image blocks and normalises older session images
  before provider requests; `/repair-session-images` performs a backed-up
  permanent repair. `image_gen` follows OpenAI Codex's standalone image tool,
  generates or edits with `gpt-image-2`, and saves outputs under
  `$CODEX_HOME/generated_images`. The integrated compact footer passively shows
  Codex 5h/7d usage and session token/cost statistics; `/pi-usage` shows the
  detailed breakdown and controls the footer.
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

The integrated Codex footer derives its token breakdown from the per-message
`usage` Pi records (input / cacheRead / cacheWrite / output and matching
per-bucket cost), so cached versus uncached input and notional API spend remain
exact without tokenizer estimation.

Codex plan-window tracking is passive: `x-codex-*` response headers and
`codex.rate_limits` WebSocket events update the persisted snapshot and footer
countdowns during the conversation.

The root `.npmrc` prevents npm from auto-installing Pi peer dependencies when
Pi installs this git package; Pi provides those packages at runtime.
