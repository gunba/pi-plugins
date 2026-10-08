# pi-config

Pi-native configuration navigator for agentic CLI settings and resource files.

## Commands

- `/pi-config` — open the configuration navigator.
- `/pcfg` — alias.
- `/pi-config <tab-or-filter>` — open a specific tab (`settings`, `md`, `skills`, `mcp`, `prompts`, `extensions`) or start with a filter.

## What it surfaces

- Pi settings only: `~/.pi/agent/settings.json`, `.pi/settings.json`, and Pi `models.json` files.
- All documented Pi settings keys with type/default/choice metadata, insertable into user or project settings.
- Pi context files using Pi's loading semantics: the first `AGENTS.md` / `CLAUDE.md` found in the user agent dir and each workspace ancestor, plus active `.pi/SYSTEM.md` and `.pi/APPEND_SYSTEM.md` files.
- Loaded/discoverable Pi resources: skills, prompts, extensions, and MCP configs from Pi user/project paths plus `.agents/skills` compatibility paths.

## Editing model

In the terminal, the main navigator is a centered `ctx.ui.custom(..., { overlay: true })` modal with first-class tabs instead of one giant mixed list:

- **Settings** — Pi JSON settings/model files and every supported Pi setting key with type/default metadata.
- **.MD context** — Markdown files that Pi actually loads (`AGENTS.md`/`CLAUDE.md`, active `SYSTEM.md`, active `APPEND_SYSTEM.md`).
- **Skills**, **Prompts**, **MCP**, and **Extensions** — focused Pi resource views with scope badges and resource icons.

Use `Tab`/arrow keys to switch tabs, type to filter within the active tab, and `Enter`/`Ctrl+E` to edit the selected file. The modal now uses nearly the full terminal (`96%` wide, `94%` high) with many more visible rows, a split-pane preview on wide terminals, and a stacked layout on narrow terminals.

In the Settings tab, setting-key rows are first-class items: `Enter` inserts the setting into project `.pi/settings.json`, while `Ctrl+G` inserts into user `~/.pi/agent/settings.json`. Editing a Pi settings file opens an in-modal JSON editor with the complete Pi settings reference visible beside it; `Tab`/`Ctrl+R` focuses the reference, `Enter` inserts the highlighted setting into the JSON, and `Ctrl+S` saves. On a settings file row, `Ctrl+A` also opens the standalone in-modal reference catalog with setting keys, value type, enum choices, defaults, descriptions, and whether the key already exists. Saves are atomic and followed by an optional Pi resource reload prompt; some settings still require a new session or restart to take effect.

Saving checks the original file under Pi-compatible locks. A concurrent edit is
reported instead of overwritten. Reload closes the navigator; reopen `/pi-config`
afterward to continue editing. Context-window uses the same file-lock and atomic
replacement helpers for its paired model/settings updates.

## Pi Desk

Open **Pi settings & resources** in session settings, or use `/pi-config`.
The browser has searchable categories for settings, instructions, skills, prompts,
extensions and MCP files. Results are paged on the owning computer, including
large resource inventories.

Settings show Pi's effective merged values, saved global/project values and the
documented reference defaults separately. Keys returned by Pi or present in saved
settings remain visible even if they have no reference entry. Reviewing a setting
opens its scoped JSON file before any save; existing values are retained.

Desk supplies loaded-resource metadata from the conversation's native loader,
including extensions that register no commands. Files merely found on disk are
identified separately. Skills being loaded means available by name, not that their
full contents have already entered the conversation. Hosts without the native
inventory report that limitation. Previews show saved files, not a live prompt;
**Opening context** shows the conversation's assembled prompt.

Editing reuses the terminal's JSON validation, protected projection and checked
file writer. Managed runtime resources are read-only. Use **Reload Pi resources**
after saving; some settings need a new session. A host-only update does not replace
an older conversation's configuration controller.

Standard credential, authorization, environment, connection-command and URL
fields in JSON stay on the computer. The remote editor receives placeholders;
saving preserves the original values, and moving or removing a protected
placeholder is rejected. Token-budget settings remain editable. Change
protected connection fields on the computer. Malformed JSON and files above
256 KiB require a local editor. Ordinary resource text is shown as file content.

Changing sessions or branches retires open configuration actions. The writer
rechecks that lifetime after acquiring the file lock and during rename retries.
