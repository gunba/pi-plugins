# Command protection

`pi-command-guard` checks model-issued shell commands for drive destruction and
Git wipes before Pi executes them. It uses Pi's `tool_call` hook, including nested calls made through
`ctx.executeTool`, and is inherited by SDK children through the parent policy bus.
It registers no model tools, prompt instructions or bypass
command. The policy runs in process; it does not launch a shell, consult a model,
read scripts, or execute a command to decide whether to admit it.

## Policy

- Block recognized deletion of entire filesystem/drive roots or their contents,
  formatting of drives/volumes, and raw-device overwrites.
- Confirm Git wipes: hard reset, whole-tree cleanup or restoration, forced
  checkout/switch, clearing stashes or repository-wide reflogs, deleting `.git`
  history, and remote-history overwrites without a lease check.
- Allow ordinary file cleanup, recursive/wildcard deletion, file writes/edits,
  inline programs, database/cloud operations and targeted Git maintenance without
  a guard prompt. `--force-with-lease` retains Git's own concurrency check.
- Inspect supported shell wrappers, literal evaluation/encoded commands and inline
  programs. Unknown targets or syntax do not trigger approval. Parsing is bounded
  to 16 KiB and four nested layers; it is not a full shell or language interpreter.
- Approval applies to the exact current call and working directory, not later
  commands. Cancellation, timeout, context replacement and unavailable UI do not
  grant approval. Desk's Away setting does not grant required confirmations.

A `pass` result means no drive/Git wipe rule matched, **not that the command is safe**. This is
mistake prevention, not a security boundary. It does not analyze whole programs,
read invoked script files, resolve shell aliases/functions or filesystem links,
follow imported code, or govern arbitrary extension code, remote MCP operations,
browser actions and processes already running. A model can affect anything its
OS account can access through those routes. Protecting against hostile or
obfuscated code requires OS isolation and restricted credentials; a command
filter cannot provide that guarantee.

## Installation and replacement

The aggregate package loads `pi-command-guard/index.ts`. There are no
project-configurable policy exceptions or saved approvals. Like other Pi
extensions, loading the guard itself depends on trusted resource configuration.

Exclude a retired external guard through native resource settings when this
extension is available, then verify uptake at a safe resource reload or worker
start. Leaving both loaded retains the external guard's broader restrictions
and subprocess failures; a confirmation here cannot override its veto. Installing this package never disables or
uninstalls another guard automatically. Host-only updates leave existing workers
and their loaded protection unchanged.

Regression fixtures classify synthetic commands and use fake executors for
native direct, Codemode and SDK-child calls. They do not run destructive commands.
