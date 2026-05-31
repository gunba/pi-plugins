# pi-plugins

Custom Pi extensions packaged as one auto-updatable Pi package.

## Extensions

- `pi-codex-transport` — Codex WebSocket/SSE transport fixes, timeout control, and diagnostics.
- `pi-codex-usage` — passively shows Codex 5h/7d usage and reset timers in a compact two-line footer.
- `pi-config` — adds `/pi-config` and `/pcfg` for Pi-native settings, context, skills, MCP, and subagent configuration.
- `pi-nested-skills` — presents Agent Skills as nested categories via portable frontmatter metadata.
- `pi-tab-title` — auto-names terminal tabs from the first user message and shows fresh/thinking/ready/error state in the tab title.
- `pi-resume-search` — adds `/resume-search` and `/rs` for full-session resume search with match snippets.
- `pi-system-context` — adds compact local environment context to the system prompt.
- `pi-memedit` — automatically hard-deletes low-value conversation items from live context and the session log after each turn; disabled by default in pi-subagents child processes and compatible with Anthropic OAuth prune calls.

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

`pi-codex-usage` does not poll OpenAI or ChatGPT usage endpoints. It updates from `x-codex-*` headers and `codex.rate_limits` WebSocket events already returned by Codex requests, persists the latest snapshot locally, and refreshes countdown/session footer rendering during the conversation.

The root `.npmrc` prevents npm from auto-installing Pi peer dependencies when Pi installs this git package; Pi provides those packages at runtime.
