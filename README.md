# pi-plugins

Custom Pi extensions packaged as one auto-updatable Pi package.

## Extensions

- `pi-codex-debug-probe` — safe Codex transport/session diagnostics for SSE/WebSocket stalls.
- `pi-nested-skills` — presents Agent Skills as nested categories via portable frontmatter metadata.
- `pi-sse-timeout` — overrides the hard-coded OpenAI Codex SSE response-header timeout and logs timeout behaviour.
- `pi-system-context` — adds compact local environment context to the system prompt.

`job-done` was intentionally removed.

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

The root `.npmrc` prevents npm from auto-installing Pi peer dependencies when Pi installs this git package; Pi provides those packages at runtime.
