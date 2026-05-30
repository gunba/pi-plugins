# pi-config

Pi-native configuration navigator for agentic CLI settings and resource files.

## Commands

- `/pi-config` — open the ask-user-style overlay navigator.
- `/pcfg` — alias.
- `/pi-config <filter>` — open the overlay with an initial filter, e.g. `/pi-config mcp`.

## What it surfaces

- Pi settings: `~/.pi/agent/settings.json`, `.pi/settings.json`, `models.json`, package/resource paths.
- Pi context files: global and current-workspace `AGENTS.md` / `CLAUDE.md`, plus `.pi/SYSTEM.md` and `.pi/APPEND_SYSTEM.md`.
- Loaded Pi resources from the current session: skills, prompts, and extension command sources reported by Pi.
- Compatibility files for Claude Code and Codex: settings, hooks, context, skills/commands, and MCP-related config files.
- Non-native plugin surfaces when present by convention, including `pi-mcp-adapter` config files and `pi-subagents` agent definitions.

## Editing model

The extension stays inside the Pi terminal. The main navigator is a custom `ctx.ui.custom(..., { overlay: true })` popup with type-to-filter search, keyboard navigation, and a split-pane details preview on wide terminals. Follow-up actions use Pi's built-in text input, confirmation, and multi-line editor APIs rather than opening a separate desktop app.

For settings files, choose **Add setting from reference** or **Add environment variable from reference** to insert a sensible default, review the whole file in the editor, and save atomically. After saving, the extension offers to run Pi's resource reload; some settings still require a new session or restart to take effect.
