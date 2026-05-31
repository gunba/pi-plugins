---
name: pi-settings-import
description: Import a Pi settings bundle produced by /pi-export onto this machine, translating paths for the current OS, backing up what it overwrites, reinstalling packages, and remediating machine-specific values. Use when the user wants to restore, import, or sync their Pi user setup (skills, agents, themes, MCP, config) from a .zip exported on another machine.
---

# Pi Settings Import

Restore a `pi-settings-*.zip` bundle (created by `/pi-export`) onto this machine. The
export is deterministic; the import is run by you because it needs judgment:
translating OS-specific paths, choosing how to reinstall packages, and fixing values
that only make sense on the source machine.

## The engine

All mechanical work (unzip, path detokenization, checksum verification, backups,
writes) is done by a zero-dependency Node script so nothing is hand-edited:

```
<this skill dir>/../../scripts/pi-settings-sync.mjs
```

Resolve that path against this SKILL.md's directory to get the absolute engine path,
then call it with the Node that runs Pi (plain `node` is fine). All commands accept
`--json` for machine-readable output.

- `inspect <bundle.zip> --json` — read-only. Reports source machine, file list,
  package plan, and **reviewItems** (absolute paths that do not exist on this machine).
- `apply <bundle.zip> --dry-run --json` — shows exactly what would be written/backed up. Writes nothing.
- `apply <bundle.zip> --json` — detokenizes for this machine, backs up every overwritten
  file under `~/.pi/agent/backups/settings-sync-<timestamp>/`, then writes.

## Workflow

1. **Locate the bundle.** Ask the user for the path to the `.zip` if not given.

2. **Inspect.** Run `inspect ... --json`. Summarize for the user: source OS/host, how
   many files, the packages that will need reinstalling, and every `reviewItem`. Call
   out that `apply` overwrites existing config (backed up automatically) and never
   touches `auth.json`.

3. **Preview + confirm.** Run `apply ... --dry-run --json`. Show the file count and the
   backup location, then get explicit confirmation before writing.

4. **Apply.** Run `apply ... --json`. Confirm the backup directory and applied count.

5. **Reinstall packages.** node_modules are not bundled. Run `pi update` (or
   `pi install <pkg>` for each `npm:`/`git:` package from the plan) so extensions and
   MCP servers are rebuilt. For any `local` package source, the path is from the other
   machine — ask the user where that project lives here (or drop it).

6. **Remediate reviewItems.** For each flagged value, fix it for *this* OS by editing
   the written `~/.pi/agent/settings.json` or `~/.pi/agent/mcp.json`:
   - `shellPath` / `npmCommand` → set the local shell / npm, or remove to use defaults.
   - MCP `command` / `args` / `env` paths → point at where that tool is installed here,
     or reinstall the tool. Ask the user when the location is unknown.
   - `skills` / `prompts` directories → create them, repoint them, or remove the entry.

7. **Finish.** Remind the user to re-authenticate (auth was excluded by design) and that
   a Pi restart may be needed for settings, extensions, and MCP changes to take effect.

## Rules

- Never invent install locations for flagged paths — ask the user or reinstall the tool.
- Do not bypass `--dry-run` confirmation unless the user explicitly says to apply directly.
- Keep the backup directory path visible so the user can roll back.
- If `inspect`/`apply` reports `ok:false`, stop and surface the `error` — do not partially apply.
