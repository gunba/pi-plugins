# Command protection

`pi-command-guard` screens model-issued shell commands and file changes before Pi
executes them. It uses Pi's `tool_call` hook, including nested calls made through
`ctx.executeTool`, and is inherited by SDK children through the parent policy bus.
It registers no model tools, prompt instructions or bypass
command. The policy runs in process; it does not launch a shell, consult a model,
read scripts, or execute a command to decide whether to admit it.

## Policy

- Block recognized literal destruction of filesystem/drive roots, the home or working
  directory, and top-level operating-system directories. Block disk formatting
  and raw-device overwrite commands.
- Require confirmation for recursive or wildcard deletion, unresolved deletion
  targets, history-discarding Git operations, force pushes and recognized cloud
  or database deletion commands.
- Require confirmation before direct file tools change system files, credentials
  or Git internals. Ordinary workspace file edits remain available.
- Inspect supported shell wrappers, literal evaluation/encoded commands and inline
  programs for recognized destructive calls. Unknown syntax, input, executable names
  or program behavior do not trigger approval on their own. Parsing is bounded to
  16 KiB and four nested layers; reaching those limits does not establish a threat.
  This does not implement every shell or language grammar.
- Approval applies to the exact current call and working directory, not later
  commands. Cancellation, timeout, context replacement and unavailable UI do not
  grant approval. Desk's Away setting does not grant required confirmations.

A `pass` result means no rule matched, **not that the command is safe**. This is
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

When replacing another guard, keep it enabled until the new worker reports this
extension without errors and the platform acceptance tests pass. Then exclude the
old wrapper through native resource settings and verify the new guard on the next
safe resource reload or worker start. Installing this package never disables or
uninstalls another guard automatically. Host-only updates leave existing workers
and their loaded protection unchanged.

Regression fixtures classify synthetic commands and use fake executors for
native direct, Codemode and SDK-child calls. They do not run destructive commands.
