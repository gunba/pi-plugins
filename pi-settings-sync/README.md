# pi-settings-sync

Move your whole user-level Pi setup between machines — Linux ↔ Windows included.

`/pi-export` writes a portable `.zip` of your `~/.pi/agent` config; the
`pi-settings-import` skill restores it on another machine, translating paths for the
target OS and remediating anything machine-specific.

## Commands

- `/pi-export` (alias `/pi-settings-export`) — export to a zip on the Desktop.
  - Optional argument: an output directory or `.zip` path, e.g. `/pi-export ~/backups`.
- `/pi-settings-import` (skill) — import a bundle. Run it, or just ask: *"import my Pi
  settings from `<path>`"*. The agent inspects, previews, applies, reinstalls packages,
  and fixes OS-specific values.

## What travels

Bundled (path-translated where needed):
`settings.json`, `mcp.json`, `models.json`, `subagents.json`, `AGENTS.md`, and the
`skills/`, `agents/`, `themes/`, `prompts/` directories.

Excluded by design:

- **Secrets** — `auth.json` is never bundled. Re-authenticate after import.
- **Regenerable** — `npm/` (node_modules), `bin/`, and caches. Run `pi update` after
  import to rebuild extensions and MCP servers.
- **Per-machine history** — `sessions/`, run history, and knowledge bases.

## How cross-OS works

Config files embed absolute paths (`/home/you/...`, `C:\Users\You\...`,
`~/.pi/agent/...`, `~/.codex/...`). On export those roots are rewritten to neutral
sentinels; on import they expand to the **target** machine's roots (always forward-slash,
so the JSON stays valid on Windows). Paths that are genuinely machine-specific and don't
exist on the target — a shell binary, an MCP server's install path, a local package
source — can't be auto-translated. The importer surfaces every one of them as a
**review item** so the agent (with you) fixes them, instead of silently writing a broken
config.

Imports are non-destructive: every file the import would overwrite is first copied to
`~/.pi/agent/backups/settings-sync-<timestamp>/`.

## Engine

`scripts/pi-settings-sync.mjs` is a zero-dependency Node script (its own ZIP
reader/writer) that does all deterministic work and backs both the command and the
skill: `export`, `inspect`, and `apply [--dry-run]`, each with `--json`.
