# pi-plugins

Custom Pi extensions packaged as one auto-updatable Pi package.

## Extensions

- `pi-fixes` — bundled workarounds for upstream Pi issues, with built-in effectiveness tracking. Covers the Codex SSE 10s header-timeout suppression (`/sse-timeout`, `/codex-transport`) and the oversized single-message guard before provider requests and tool-call continuations (`/context-guard`). `/pi-fixes` reports whether each fix is still firing (last 7d/30d, last seen, NEEDED/REVIEW/UNUSED verdict) so a workaround can be retired once its failure stops occurring.
- `pi-usage` — passively shows Codex and Claude 5h/7d usage and reset timers in a compact two-line footer, plus a cumulative conversation token/cost breakdown (uncached input, cached input with hit rate, output, and total `$`) on the stats line; `/pi-usage` prints the full per-bucket token and cost attribution for the current model.
- `pi-config` — adds `/pi-config` and `/pcfg` for Pi-native settings, context, skills, MCP, and subagent configuration.
- `pi-lazy-skills` — removes the full skill list from the main prompt and uses a pre-turn selector to inject only likely relevant Agent Skills.
- `pi-tab-title` — auto-names terminal tabs from the first user message and shows fresh/thinking/ready/error state in the tab title.
- `pi-system-context` — adds compact local environment context to the system prompt.
- `pi-context-ledger` — prints a one-time, TUI-only breakdown of pre-conversation context (system prompt, skills, MCPs, tools, first message) after the first user message; never sent to the model.
- `pi-memedit` — automatically hard-deletes low-value conversation items from live context and the session log, including optional live continuation pruning during long runs; follows its global setting and is compatible with Anthropic OAuth prune calls.
- `pi-subagents` — runs background `pi` subagents as a coordinated team. `spawn` starts a named subagent on a task; `message`/`wait` provide a live intercom (agent↔agent and agent↔main); nested spawns are gated by the main agent's approval; and a styled, on-by-default `/subagents` team view shows the live tree. Subagents inherit the full plugin stack, run headless, resume from their own memory when re-addressed, and stay out of `/resume`.
- `pi-settings-sync` — adds `/pi-export` and the `/pi-settings-import` skill for full user-level settings migration between machines (Linux ↔ Windows), translating OS-specific paths and excluding secrets, node_modules, and history.

## Install

```bash
pi install git:github.com/gunba/pi-plugins
```

Do not pin a ref if you want Pi startup/update checks to detect new commits. Use:

```bash
pi update --extensions
```

or plain:

```bash
pi update
```

## Development

The package manifest at the repository root loads the extension files from the `pi-*` subdirectories. Keep plugin directories and package names prefixed with `pi-`.

The footer stats line derives its token breakdown from the per-message `usage` Pi already records (input / cacheRead / cacheWrite / output and matching per-bucket cost), which is normalised identically for Codex and Claude, so cached vs uncached input and spend are exact for both — no tokenizer estimation required.

`pi-usage` does not poll any usage endpoints. It updates from data already returned by provider requests — Codex `x-codex-*` headers and `codex.rate_limits` WebSocket events, and Claude `anthropic-ratelimit-unified-*` headers (sent when Pi uses an Anthropic OAuth/Claude Code subscription) — persists the latest snapshot per provider locally, and refreshes countdown/session footer rendering during the conversation. The footer shows whichever provider was used most recently.

The root `.npmrc` prevents npm from auto-installing Pi peer dependencies when Pi installs this git package; Pi provides those packages at runtime.
