# pi-plugins

Pi extensions and skills, installed as one Pi package, plus Pi Desk. Requires Node.js 22.19+ and Pi 1.0+.

```bash
pi install git:github.com/gunba/pi-plugins
pi update --extensions    # this package; `pi update --all` updates Pi too
```

Do not pin a ref, or Pi's update checks will not see new commits.

## Desk

- [`pi-desk`](pi-desk/README.md): the desktop and phone app. Conversations run on the computer they belong to and
  appear in one web app; a relay gives remote access without opening ports on the computers.

## Agent tools

- [`pi-agents`](pi-agents/README.md): start and message other agents: conversations on any of the user's computers, or
  background helpers that report back. Also the user's quest list.
- [`pi-ask-user`](pi-ask-user/index.ts): the `ask_user` tool (a fork of `pi-ask-user` 0.11.2 without its decision-gate
  skill).
- [`pi-plan`](pi-plan/README.md): one objective and checklist per branch, with optional automatic continuation.
- [`pi-show`](pi-show/README.md): `show` presents results in Desk, including live HTML pages; file changes are
  computed for text, spreadsheets, documents and decks.
- [`pi-watch`](pi-watch/README.md): `watch` waits without spending turns, for a command's output, a change, or a time.
- [`pi-web-search`](pi-web-search/README.md): `web_search` and `web_fetch`, through Parallel or, with a key, Exa.
- [`pi-command-guard`](pi-command-guard/README.md): asks before commands that would wipe a drive or a Git working tree.

## Models, context and cost

- [`pi-codex-wire`](pi-codex-wire/README.md): the ChatGPT Codex transport (requests identify as Codex Desktop or CLI),
  allowance status, `/pi-usage` and the Fast tier.
- [`@gotgenes/pi-anthropic-auth`](https://github.com/gotgenes/pi-anthropic-auth): Claude sign-in. The Pi update
  workflow updates it hourly to its latest release.
- [`pi-output-budget`](pi-output-budget/README.md): Pi's own output limits (2,000 lines or 50 KB) for every tool, with
  the full text saved to a file; images read at most 1.5 MB.
- [`pi-compaction-context`](pi-compaction-context/README.md): compaction summaries and briefs from the prompt cache
  while it is warm; Pi's own summary otherwise.
- [`pi-session-memory`](pi-session-memory/README.md): frees memory held for compacted history in terminal Pi.
- [`pi-context-window`](pi-context-window/README.md): `/context-window`, the model's window and compaction threshold.
- [`pi-system-context`](pi-system-context/README.md): the computer's environment in the system prompt.
- [`pi-system-one`](pi-system-one/README.md): when to use classifier models such as Jev through codemode.
- [`pi-config`](pi-config/README.md): `/pi-config` for Pi's settings, context files, skills and MCP servers.

## Terminal

- [`pi-fast-footer`](pi-fast-footer/README.md): a footer that does not rescan the transcript on every redraw.
- [`pi-context-ledger`](pi-context-ledger/README.md): what the first request's context is made of.
- [`pi-local-links`](pi-local-links/README.md): relative file links made clickable.
- [`pi-message-timestamps`](pi-message-timestamps/README.md): message and tool timing.

## Skills and prompts

Skills live in Pi's skills folder (`~/.pi/agent/skills`), which Desk mirrors between the user's computers, not in this
package.

- [`pi-improve-skill`](pi-improve-skill/README.md): tooling for building and iterating on skills: the mining and
  benchmarks behind the code skills.
- [`pi-prompts`](pi-prompts/corrections.md): `/corrections` finds where the user corrected agents and proposes fixes.

## Shared code

`pi-ui` (what extensions publish to Desk), `pi-work-ui` and `pi-work-coordination` (the terminal's work panel),
`pi-session-usage` (usage totals) and `pi-session-ownership` (one writer per session) are used by the packages above.

## Development

```bash
npm ci
npm --prefix pi-desk ci --ignore-scripts
npm run check                  # typecheck and tests
npm --prefix pi-desk run typecheck && npm --prefix pi-desk run build
```

[`AGENTS.md`](AGENTS.md) has the focused commands and the release runbook. Pi's packages are optional peers, provided
by Pi at runtime; the pinned development copies are for type checks and tests.
