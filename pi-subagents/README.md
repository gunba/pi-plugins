# pi-subagents

Durable native Pi agents with a Codex V2-style control surface. Requires Pi 1.0.
Each child uses an in-process SDK `AgentSession`, with its own context, model
runtime and native history. Children share the working directory, not a sandbox.

## Tools

| Tool | Behavior |
|---|---|
| `spawn_agent(task_name, message, fork_turns?, model?, reasoning_effort?)` | Starts asynchronously. Returns `{task_name, agent_id}` after durable admission, not completion. |
| `send_message(target, message)` | Sends information within the registered tree without starting an idle recipient. Returns `{message_id}`. |
| `followup_task(target, message)` | Requests work from any non-root agent in the tree. An active recipient receives it at a safe boundary; an idle recipient starts a turn. Returns `{message_id}`. |
| `wait_agent(timeout_ms?)` | Waits for mailbox activity or user input. Returns `{message, timed_out}`; does not end the turn. |
| `interrupt_agent(target)` | Interrupts the current turn or initialization. Returns `{previous_status}`. Root/self targets are rejected. |
| `list_agents(path_prefix?)` | Lists the registered tree, optionally limited to a subtree. Returns `{agents}` with task paths, native IDs and statuses. |

`task_name` is unique under the creating agent and uses lowercase ASCII letters,
digits and underscores; `root` is reserved. Paths look like
`/root/parser_review/tests`. Targets accept canonical paths, descendant-relative
paths or native agent IDs. Relative paths do not support `.` or `..`. Messages
cannot cross owning root trees; [party messaging](../pi-party/README.md) handles
independent agents and computers.

`fork_turns` defaults to `"all"`: copy completed effective parent context. Use
`"none"` for a fresh context or a positive integer string such as `"2"` for recent
retained instruction turns. The unfinished delegation turn is excluded. Bounded
copies begin at an instruction boundary, not midway through a tool batch.

```json
{"task_name":"parser_review","message":"Review the parser for edge cases.","fork_turns":"none"}
```

Final results go to the original parent automatically, without starting a parent
turn. `send_message` handles interim communication in either direction; there is
no separate `report` tool. `subagent`, `subagent_fork`, foreground creation flags
and ID-targeted waits are not model-facing aliases.

Discovery distinguishes `running` (active), `idle` (resident or queued) and
`ready` (cold but resumable). Missing or invalid histories appear as diagnostics.
A known cold target is not opened by messaging, discovery or interruption;
unknown targets are errors. Interruption preserves queued work, descendants and
history. An explicit follow-up or owning-driver resume can unpark retained work.

`wait_agent` defaults to 30 seconds, clamps shorter requests to 10 seconds and
allows up to one hour. Already unread notifications return immediately. Timeout
does not cancel work. SDK, RPC and terminal sessions use the same pending tool.
Use `write_stdin` for processes; see [agent waiting](../pi-work-coordination/README.md).

## Model, account and tool choices

Children inherit model and thinking by default. Overrides use an exact
`provider/model` ID and/or `reasoning_effort`. The first override requires human
approval for the root conversation; descendants share that decision. Invalid
models or unsupported explicit effort fail before approval or session creation.
A model-only override adjusts inherited effort to the model's supported levels.

- `/subagents permissions` shows the decision.
- `/subagents permissions allow` requests approval, including after a denial.
- `/subagents permissions revoke` blocks future overrides; existing choices remain.

Headless runs cannot grant approval. The decision is stored outside copied
conversation text at `~/.pi/agent/subagents/permissions/<root-session-id>.json`.
Resume, compaction and branch navigation retain it; a new root or fork requires
its own decision.

Each activation gets fresh model-runtime state. The owning host supplies account
bindings, including Desk's saved account selections. Scoped child credentials
take precedence over inherited fallback authentication for their provider.
Otherwise the adapter inherits the parent's provider configuration and credential
resolver, including native OAuth refresh. Messaging and cold resumption do not
replace saved account choices or the descriptor's model/thinking selection.

Children follow the root's current enabled tools rather than a coding-tool
whitelist. Revocations are checked again at execution, and provider restrictions
remain effective. The saved tool list records launch selection; it is not a
permanent activation whitelist. Renaming a tool does not create an alias or grant
an explicitly revoked capability.

Provider factories are recreated against the child's API, cwd, session and model.
Hooks are retained; flags come from the parent configuration. Parent execution
closures are not copied. Descendants use the original root source catalog.
Each provider has its own API object, so a registration decorator cannot replace
another provider's callback.

Hook-only policies opt into child loading through the synchronous session bus:

```typescript
const unsubscribe = pi.events.on("pi-subagents:child-policies:v1", (request) => {
  request.policies.push({ path: fileURLToPath(import.meta.url), scope: "user" });
});
pi.on("session_shutdown", unsubscribe);
```

Scopes are `user`, `project` or `temporary`. Project policies require trust;
policies are deduplicated with tool providers by canonical path. SDK hosts can
supply the same metadata through `RuntimeHost.getChildPolicySources()`.

Each activation has a private JavaScript module graph shared across its provider
entrypoints, using the pinned [Jiti adapter](loader/README.md). This isolates
module state, not operating-system access. Native framework APIs and addons remain
shared. Missing provider sources fail activation; SDK hosts can supply child-bound
definitions for tools without source files.

Party tools have child-local registration and membership. Children do not inherit
the parent's party. Incoming peer work remains under the owning driver.

Desk gives each active child a human-interaction scope. Questions identify that
child and survive browser disconnects; interruption cancels its pending questions,
not a sibling's. Hosts without this presentation require questions to be escalated
to the parent. Project trust and direct-human approval requirements still apply.

## Delivery and lifetime

Acceptance is durable before execution. New explicit follow-ups can join the
active invocation through native start/turn-boundary hooks; inputs arriving after
its final boundary remain queued for another invocation. Existing historical FIFO
inputs keep their order and form a barrier to early delivery of newer inputs.
No opaque Pi queue is cleared or rewritten.

Each invocation publishes its own terminal result. Queued invocations can reuse a
driver, but their results remain separate. A finished or parked agent releases its
SDK activation without waiting for descendants; its history, identity and inbox
remain. Descendants continue independently, and later results stay in the cold
parent's inbox. Reading that inbox's history does not start the parent.

Ordinary crash recovery is at-least-once: a started input without a terminal
receipt may run again. A terminal receipt atomically identifies follow-ups
consumed by the same invocation, preventing their separate replay. Unconfirmed
started maintenance continuations instead require fresh work. Recovery of a
missing result does not unpark queued work or start a model turn.

Messages and final results use durable inbox/outbox receipts. A sender's outbox
is acknowledged only after destination admission. Native custom-message IDs
prevent repeated context admission; compaction retains these IDs while releasing
old payloads. Explicit messages retain their full content; automatic final-result
summaries are bounded. Final output already delivered to the same parent in the
same invocation is not repeated.

Routine final notices within 50 ms can share one context message; a root tool
boundary flushes them before the next model request. Errors and explicit messages
bypass that delay. A pending `wait_agent` responds to mailbox activity. Neither
routine messages nor final notices manufacture a new prompt for an idle agent.

Forks copy effective compaction-aware context, including content edits and
removals. The seed is captured once. Checkpoint details survive reopening and
nested forks; copied objects are independent of the parent's resident history.
Skills remain native Pi resources: advertisements describe available skills, and
content is read on demand. Desk labels observed `SKILL.md` reads, including nested
codemode calls; that label is not proof that the model followed the skill.

Defaults are depth 3, eight live child activations per root and a 30-second opening
deadline. Opening and disposal consume capacity. Cancellation cannot forcibly
stop arbitrary synchronous provider code; late drivers are disposed before their
opening slot is released. These limits do not establish acceptable cold-start
performance on every computer.

Background usage is billed once per invocation to the root's `/pi-usage` records,
including tool and compaction usage. Grouped follow-ups do not add another charge.
Historical foreground runs retain their native tool-usage handling. Native footer
totals do not themselves include these custom background records.

## Human controls

`/subagents` opens the terminal dashboard; `/work subagents` opens its shared Work
summary. The dashboard includes a nested tree, search, transcript preview, model,
thinking, usage, duration and activation errors. `m` requests a follow-up from a
continuable agent anywhere in the owning tree; `x` interrupts its current turn.

In Desk, the workspace's Agents section provides fresh/fork creation, launch
settings and permission controls. Agent panes show native transcript pages and
scoped questions. Active agents offer information-only steering and explicit
follow-up; an idle agent's Send starts a turn. Inactive agents stay in compact
history until opened. Transcript paging does not activate them.

Branch navigation is blocked while the current session owns live descendant work.
Session replacement drains live SDK activations and reconstructs the durable
catalog. Shutdown aborts active turns child-first without deleting sessions.

Desk maintenance uses the owning runtime's checkpoint route. It parks active
work, records final native branch positions and releases only the work confirmed
interrupted by that checkpoint. Idle children remain idle. Undelivered inputs,
opaque native context, opening/closing activations and failed saves block the
update; child history changed after a checkpoint is not rewound. Follow-ups
already delivered into the current native context belong to that invocation,
not an undispatched queue.

## Storage

Native JSONL histories live under:

```text
~/.pi/agent/subagents/sessions/<root-session-id>/*.jsonl
```

The root retains a cooperative session-ownership lease for each child file between
activations, releasing it after shutdown and any late opening cleanup. Another
ownership-aware Pi process cannot resume the same file concurrently.

Model-hidden native entries include:

- `pi-subagents/descriptor-v1`: first-authoritative identity, lineage, depth,
  model/thinking, context mode, launch tools and trust ceiling; payload version 2.
- `pi-subagents/task-name-v1`: immutable routing name. Older histories derive a
  stable name from the native ID without rewriting the descriptor.
- `pi-subagents/inbox-v1`: accepted inputs; new boundary delivery is distinguished
  from historical FIFO inputs.
- `pi-subagents/delivery-v1`: start/terminal receipts, invocation `workId`, usage and
  any atomically `consumedFollowups` IDs.
- `pi-subagents/control-v1`: explicit parking/resume state.
- `pi-subagents/maintenance-v1` in the root: hold, final cursor proofs and release.
- `pi-subagents/launch-v1`: branch-aware ownership.
- `pi-subagents/settlement-v1`: pending/acknowledged message and result outbox.
- `pi-subagents/notice-received-v1`: destination admission before context append.
- `pi-subagents/usage-v1` in the root: deduplicated background charges.

Native custom messages `pi-subagents/notice` and `pi-subagents/followup` carry
context and delivery IDs. Multiple follow-ups delivered before the first request
share one instruction-boundary message. Pruning preserves their IDs, not obsolete
payloads; the append-only session archive remains complete.

Transcript previews use Pi's parser, incremental appended-entry reads and bounded
render caches. They handle rotation, truncation and branch ancestors without
altering files. Missing, corrupt or unsupported children remain visible as
diagnostics rather than disappearing.

## Codex and Pi boundaries

The public surface follows the [Codex V2 specification](https://github.com/openai/codex/blob/80e0b51c9e44853471fae105032fa000c77d3e4a/codex-rs/core/src/tools/handlers/multi_agents_spec.rs).
Codex also has a separate V1 interface; this does not claim that every Codex
configuration selects V2.

Pi-specific behavior remains:

- Native session IDs accompany task paths, and `ready` identifies unloaded agents.
- Forks exclude the unfinished delegation turn. Positive `fork_turns` counts
  retained instruction boundaries, including native follow-up batches.
- Model overrides use provider-qualified IDs, Pi effort levels and human approval;
  there is no unsupported `agent_type` or special `/morpheus` role.
- The extension owns the durable tree, delivery receipts, resource limits and cold
  activation. It does not add a separate inference scheduler.
- Pi's public boundary hooks deliver active follow-ups. Existing FIFO journal
  inputs and native checkpoint rules remain authoritative.
- Source factories, scoped credentials and native trust/permission hooks are
  retained; module isolation is not process isolation.
- Custom dashboards use `pi-ui`; RPC hosts without it still receive ordinary
  tool results and notices. Pi lifecycle replacement recreates SDK activations
  rather than carrying live objects between sessions.

The original design drew on DeepSeek Harness. Its historical attribution and
license remain in [DSH-DESIGN-ATTRIBUTION.md](DSH-DESIGN-ATTRIBUTION.md).
