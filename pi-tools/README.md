# One request tool for Desk

Desk uses one request tool by default for all built-in and plugin operations.
Chrome and MCP-server operations retain their own interfaces.

## Interface

Desk declares `codemode` instead of its individual operations. The name and native
raw-source grammar are retained for Codex Wire and existing histories. Claude sends
`{code: "..."}`; providers supporting the native grammar send JavaScript directly.

The request is an async JavaScript body in the existing QuickJS sandbox:

```js
const results = await Promise.all([
  tools.read({path: "config.json", description: "Read configuration"}),
  tools.bash({command: "git status --short", description: "Inspect changes"}),
]);
return {config: results[0], changes: results[1].error ?? results[1].output};
```

`await` orders dependent effects. `Promise.all` batches independent work. Loops,
conditions, `models.classify`, image generation and branch-local `store`/`load` are
native codemode facilities, not a second interpreter. Long writes can use template
literals or construct content from earlier reads without sending it back through
the model. Backticks and literal `${` still need escaping in template literals.

Each operation returns its native structured data when available, otherwise text.
Failures become `{error: string}` rather than rejecting and discarding independent
results. Check errors before dependent effects. A request that ends normally after
operations failed lists them after its output (name and error, at most five), so an
unchecked failure is not reported as success. Script syntax/runtime errors still
fail the request; completed effects are never rolled back. Pending operations are
cancelled when the script ends. A terminal operation such as `agent_move` emits its
result and ends the script and agent turn before later effects.

Return an object or array containing only needed fields. Only explicit script output
reaches the model. The adapter removes the script status/time header and decodes a
single JSON output into `structuredContent`; other output remains text or content
blocks. Images remain attachments. Native truncation, spill paths and the output
budget's 40-line/3,000-byte excerpts remain in use.

### Operation data

- `read`, `bash`, `edit`, `write`, and MCP resources retain their native data shapes.
- Agent operations expose their existing response objects, rather than their compact
  display strings. Primary approval denial remains `{approved: false}`.
- Plans expose `{plan}`.
- `ask_user` exposes its response, cancellation state and question details.
- `show` exposes its existing shown-file description.
- `watch` exposes `{text, watches}`, including watch IDs needed to stop them.
- Web operations expose `{pages, failures}`; memory operations expose the existing
  search response. Scripts can select fields before any result reaches the model.
- `tool_search` returns `{loaded}` and still uses native search and activation.

Chrome and MCP-server operations retain their original schemas, result shapes and
rejection behavior. Any independently declared external tools remain declared.

## Discovery, safety and presentation

The fixed definition states shared conventions once and includes compact signatures
only for the four core coding operations. `searchTools`, `describeTool` and
`describeNamespace` supply other contracts on demand. Native `tool_search` is also
callable from a request. Late MCP discovery is awaited before the sandbox snapshots
its tools. Discovery does not change the fixed definition.

Underlying operations stay registered and active under their original permissions.
Every actual call uses `ExtensionToolContext.executeTool`, preserving validation,
command protection, approval/UI services, cancellation, usage and nested call IDs.
Desk receives its existing nested operation events and displays separate diffs,
plan, agent, shown-file and watch cards. No new card implementation is introduced.
Children inherit the parent's interface and tool permissions; terminal parents
using the original interface keep it in their children.

A real-session test enforces a **3,584-byte** ceiling for the provider-neutral
definition, including Desk's description field, and checks that discovery leaves
the definition unchanged.

## Why not GraphQL or a list of operations?

A static document/list cannot express read → classify → conditionally edit without
adding references, conditions and loops. That would create another programming
language, execution engine and escaping convention. Codemode already has those
facilities, the guarded execution path, provider grammar support and Desk cards.
The change therefore subsumes ordinary calls into codemode, rather than making
codemode an operation inside a second orchestrator.

File and shell operations use this same entry point, not a separate direct-call
path. Write valid JavaScript with key:value pairs in object literals. Node globals
such as `process`, `require` and `Buffer` are unavailable in QuickJS; use `tools.bash`
to run Node or shell code.
