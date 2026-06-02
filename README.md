# pi-plugins

Custom Pi extensions packaged as one auto-updatable Pi package.

## Extensions

- `pi-codex-transport` — Codex WebSocket/SSE transport fixes, timeout control, and diagnostics.
- `pi-usage` — passively shows Codex and Claude 5h/7d usage and reset timers in a compact two-line footer.
- `pi-config` — adds `/pi-config` and `/pcfg` for Pi-native settings, context, skills, MCP, and subagent configuration.
- `pi-lazy-skills` — removes the full skill list from the main prompt and uses a pre-turn selector to inject only likely relevant Agent Skills.
- `pi-tab-title` — auto-names terminal tabs from the first user message and shows fresh/thinking/ready/error state in the tab title.
- `pi-resume-search` — adds `/resume-search` and `/rs` for full-session resume search with match snippets.
- `pi-system-context` — adds compact local environment context to the system prompt.
- `pi-context-ledger` — prints a one-time, TUI-only breakdown of pre-conversation context (system prompt, skills, MCPs, tools, first message) after the first user message; never sent to the model.
- `pi-memedit` — automatically hard-deletes low-value conversation items from live context and the session log, including optional live continuation pruning during long runs; disabled by default in pi-subagents child processes and compatible with Anthropic OAuth prune calls.
- `pi-settings-sync` — adds `/pi-export` and the `/pi-settings-import` skill for full user-level settings migration between machines (Linux ↔ Windows), translating OS-specific paths and excluding secrets, node_modules, and history.
- `pi-clones` — forks the running agent into a background clone that inherits the full session context (so it needs no briefing and can reuse warm prompt-cache prefixes), works one extra task in parallel, and alerts main with a concise completion notice; fetch full handoffs with `clone_result` only when needed. Clones boot as a resume of a forked branch (kept out of resume history), default to read-only tools, can be continued with write-enabled tools when needed, auto-compact instead of bricking, and escalate human-only decisions back to the parent. Adds `clone`/`clone_status`/`clone_result`/`clone_continue`/`clone_log`/`clone_stop`/`clone_dismiss` and `/clones`; full rationale in `pi-clones/DESIGN.md`.
- `pi-context-guard` — enforces a final oversized-message guard before provider requests and automatic tool-call continuations by saving giant tool/custom/bash/assistant context items to markdown files and replacing them with concise file pointers. Defaults to 50k tokens per message; configure with `/context-guard`.

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

`pi-usage` does not poll any usage endpoints. It updates from data already returned by provider requests — Codex `x-codex-*` headers and `codex.rate_limits` WebSocket events, and Claude `anthropic-ratelimit-unified-*` headers (sent when Pi uses an Anthropic OAuth/Claude Code subscription) — persists the latest snapshot per provider locally, and refreshes countdown/session footer rendering during the conversation. The footer shows whichever provider was used most recently.

The root `.npmrc` prevents npm from auto-installing Pi peer dependencies when Pi installs this git package; Pi provides those packages at runtime.
