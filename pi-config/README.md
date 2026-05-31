# pi-config

Pi-native configuration navigator for agentic CLI settings and resource files.

## Commands

- `/pi-config` — open the tabbed terminal settings modal.
- `/pcfg` — alias.
- `/pi-config <tab-or-filter>` — open a specific tab (`settings`, `md`, `skills`, `mcp`, `agents`, `extensions`) or start with a filter.

## What it surfaces

- Pi settings only: `~/.pi/agent/settings.json`, `.pi/settings.json`, and Pi `models.json` files.
- All documented Pi settings keys with type/default/choice metadata, insertable into user or project settings.
- Pi context files using Pi's loading semantics: the first `AGENTS.md` / `CLAUDE.md` found in the user agent dir and each workspace ancestor, plus active `.pi/SYSTEM.md` and `.pi/APPEND_SYSTEM.md` files.
- Loaded/discoverable Pi resources: skills, prompts, extensions, MCP configs, and pi-subagents definitions from Pi user/project paths plus `.agents/skills` compatibility paths.

## Editing model

The extension stays inside the Pi terminal. The main navigator is a centered `ctx.ui.custom(..., { overlay: true })` modal with first-class tabs instead of one giant mixed list:

- **Settings** — Pi JSON settings/model files and every supported Pi setting key with type/default metadata.
- **.MD context** — Markdown files that Pi actually loads (`AGENTS.md`/`CLAUDE.md`, active `SYSTEM.md`, active `APPEND_SYSTEM.md`).
- **Skills**, **Prompts**, **MCP**, **Agents**, and **Extensions** — focused Pi resource views with scope badges and resource icons.

Use `Tab`/arrow keys to switch tabs, type to filter within the active tab, and `Enter`/`Ctrl+E` to edit the selected file. The modal now uses nearly the full terminal (`96%` wide, `94%` high) with many more visible rows, a split-pane preview on wide terminals, and a stacked layout on narrow terminals.

In the Settings tab, setting-key rows are first-class items: `Enter` inserts the setting into project `.pi/settings.json`, while `Ctrl+G` inserts into user `~/.pi/agent/settings.json`. Editing a Pi settings file opens an in-modal JSON editor with the complete Pi settings reference visible beside it; `Tab`/`Ctrl+R` focuses the reference, `Enter` inserts the highlighted setting into the JSON, and `Ctrl+S` saves. On a settings file row, `Ctrl+A` also opens the standalone in-modal reference catalog with setting keys, value type, enum choices, defaults, descriptions, and whether the key already exists. Saves are atomic and followed by an optional Pi resource reload prompt; some settings still require a new session or restart to take effect.
