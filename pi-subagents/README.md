# pi-subagents

DSH-style delegated agents for Pi 0.84.2. Children use in-process Pi SDK
`AgentSession` instances with isolated context, durable Pi sessions, direct-parent
control, and a bounded delegation depth.

## Tools

- `subagent(description, prompt, run_in_background?)` starts a fresh child. The
  child does not receive the parent conversation.
- `subagent_fork(description, prompt, run_in_background?)` starts a child seeded
  with completed parent turns. The current in-flight turn is excluded.
- `send_message(subagent_id, message)` accepts a FIFO later turn for a direct
  child. It does not redirect the active turn or return the child's answer.
- `interrupt_agent(agent_id)` requests cancellation of a descendant's current
  turn. Queued messages, descendants, identity, and durable session remain.
- `list_agents(scope?)` lists continuable direct children or all descendants.
- `report(output)` is available only inside a live continuable child. It sends
  selected self-contained content to the direct parent without ending the turn.

`description` and `prompt` are required. Continuable delegation defaults to
`run_in_background: true` and returns a durable child ID after inbox acceptance.
Set it to `false` only when the next parent action requires the result; that
route is a foreground one-shot run.

## Lifecycle and authority

- A fresh child receives no parent transcript.
- A fork copies the parent's effective compaction-aware context through the last
  completed assistant turn before the delegation call. Its seed is captured once.
- Background work does not block the parent from using ordinary tools.
- Each child has a versioned model-hidden descriptor in its Pi session.
- Accepted child messages are persisted and processed in append-order FIFO.
  A started message without a terminal delivery record is replayed after a crash,
  which provides at-least-once rather than exactly-once execution.
- A settled child releases its SDK activation but retains its session and ID.
  The next direct-parent message cold-resumes it from the descriptor.
- Only an exact live direct parent handle can send a follow-up.
- An exact live ancestor can interrupt a resident descendant.
- Only the exact resident continuable child can call `report`.
- The default maximum child depth is 3.
- Child model, effective provider configuration, resolved request auth exposed
  by Pi, and thinking level inherit from the parent at activation. Durable model
  identity and thinking level are restored from the descriptor.
- Child resources include an explicit allowlist of enabled native coding tools,
  project context, and skills. Interactive question tools are not loaded.
- Reports and settlement notices become bounded later parent turns. A settlement
  notice includes the outcome and final assistant text when available. Settlement
  delivery uses a durable outbox and is acknowledged when the parent message is
  admitted or the direct child's inbox accepts it.
- Session shutdown aborts active turns child-first and disposes SDK activations.
  It retains descriptors, inbox history, transcripts, and session files.

## Dashboard

A compact background-activity widget appears above the editor while children
exist. `/subagents` opens a full-terminal dashboard with:

- a stable nested child tree;
- running, waiting, settled, aborted, and error states;
- fresh/fork and continuable/one-shot metadata;
- model, thinking, usage, duration, transcript tail, and recent notices;
- search and narrow/wide layouts;
- `m` to send a direct-child message and `x` to interrupt the current turn.

Pi branch navigation is blocked while the current session owns live children.
Session replacement drains live SDK activations and reconstructs the durable
catalog for the replacement root.

## Storage

Child sessions use Pi's JSONL session format under:

```text
~/.pi/agent/subagents/sessions/*.jsonl
```

The child session contains model-hidden custom entries for:

- `pi-subagents/descriptor-v1` — identity, lineage, depth, model, thinking,
  context mode, and tool profile;
- `pi-subagents/inbox-v1` — accepted FIFO work;
- `pi-subagents/delivery-v1` — started and finished delivery records;
- `pi-subagents/launch-v1` — branch-aware child ownership;
- `pi-subagents/settlement-v1` — pending and acknowledged terminal-notice outbox
  records.

Reading the catalog or a transcript does not activate a cold child. A corrupt or
unsupported direct-child descriptor appears as a diagnostic row.

## Pi 0.84.2 gaps

The implementation keeps these boundaries explicit:

1. Pi has no process-global agent registry, continuation inbox, or generic job
   service. This extension owns the live registry and durable FIFO.
2. Pi cannot attach DSH message-source metadata to a real user message.
   Root reports and settlements use visible custom messages delivered as
   follow-ups; child-to-child notices use the extension inbox.
3. Pi has no public per-activation `maxTokens` override. Cold activations use the
   restored model's normal token limit.
4. Pi extensions cannot register a browser-side child catalog or composer. The
   complete interface is available in the TUI; RPC mode receives notices but no
   custom dashboard.
5. Pi tears down the extension runtime for reload, new, resume, and fork. Active
   turns are therefore aborted cleanly and durable sessions are reconstructed
   instead of preserving in-memory activations across replacement.
6. Pi does not expose executable parent tool definitions or extension event
   policies through `getAllTools()`. Children therefore recreate only the native
   built-ins that were enabled in the parent; parent tool overrides, sandboxes,
   and permission hooks do not transfer. Restrict the native child allowlist when
   those controls are required.
7. Pi does not persist an exact `turn/end` marker. Fork boundaries use the last
   completed assistant entry before the current delegation tool call.

## Design attribution

The lifecycle, tool semantics, descriptor model, authority rules, continuation
states, reporting contract, and discovery vocabulary are adapted from the MIT
licensed DeepSeek Harness design. See
[`DSH-DESIGN-ATTRIBUTION.md`](./DSH-DESIGN-ATTRIBUTION.md).
