# pi-plugins

Custom Pi extensions packaged as one auto-updatable Pi package.

## Extensions

- `pi-codex-transport` — Codex WebSocket/SSE transport fixes, timeout control, and diagnostics.
- `pi-codex-usage` — passively shows Codex 5h/7d usage and reset timers in a compact two-line footer.
- `pi-nested-skills` — presents Agent Skills as nested categories via portable frontmatter metadata.
- `pi-system-context` — adds compact local environment context to the system prompt.

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

`pi-codex-usage` does not poll OpenAI or ChatGPT usage endpoints. It updates from `x-codex-*` headers already returned by Codex requests, persists the latest snapshot locally, and refreshes only the countdown rendering between requests.

The root `.npmrc` prevents npm from auto-installing Pi peer dependencies when Pi installs this git package; Pi provides those packages at runtime.
