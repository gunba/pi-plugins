# pi-config

Pi-native configuration navigator for agentic CLI settings and resource files.

## Commands

- `/pi-config` — open the tabbed terminal settings modal.
- `/pcfg` — alias.
- `/pi-config <tab-or-filter>` — open a specific tab (`settings`, `md`, `skills`, `mcp`, `agents`, `extensions`) or start with a filter.

## What it surfaces

- Pi settings: `~/.pi/agent/settings.json`, `.pi/settings.json`, `models.json`, package/resource paths.
- Pi context files: global and current-workspace `AGENTS.md` / `CLAUDE.md`, plus `.pi/SYSTEM.md` and `.pi/APPEND_SYSTEM.md`.
- Loaded Pi resources from the current session: skills, prompts, and extension command sources reported by Pi.
- Compatibility files for Claude Code and Codex: settings, hooks, context, skills/commands, and MCP-related config files.
- Non-native plugin surfaces when present by convention, including `pi-mcp-adapter` config files and `pi-subagents` agent definitions.

## Editing model

The extension stays inside the Pi terminal. The main navigator is a centered `ctx.ui.custom(..., { overlay: true })` modal with first-class tabs instead of one giant mixed list:

- **Overview** — live Pi inventory: active model/session, tools, slash commands, and loaded resources.
- **Settings** — Pi/Claude/Codex JSON/TOML settings, model files, and hook files.
- **.MD context** — all discovered context Markdown including `AGENTS.md`, `CLAUDE.md`, `SYSTEM.md`, and `APPEND_SYSTEM.md` across Pi/Codex/Claude scopes.
- **Skills**, **Prompts**, **MCP**, **Agents**, and **Extensions** — focused resource views.

Use `Tab`/arrow keys to switch tabs, type to filter within the active tab, and `Enter`/`Ctrl+E` to edit the selected file. Wide terminals get a split-pane preview; narrow terminals fall back to a stacked layout without spilling past the terminal width.

For JSON/TOML settings files, choose **Add setting from reference** (or `Ctrl+A`) to open an in-modal reference catalog that shows setting keys, value type, enum choices, defaults, descriptions, and whether the key already exists. Selecting a setting inserts a sensible default, opens the full-file review editor, and saves atomically only after review. Environment-variable insertion uses the same in-terminal reference flow where supported. After saving, the extension offers to run Pi's resource reload; some settings still require a new session or restart to take effect.
