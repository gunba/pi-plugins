# pi-subagents

DSH-style delegated agents for Pi 0.84.3. Children use in-process Pi SDK
`AgentSession` instances with isolated context, durable Pi sessions, direct-parent
control, bounded delegation depth, and root-wide admission limits.

## Tools

- `subagent(description, prompt, run_in_background?)` starts a fresh child. The
  child does not receive the parent conversation.
- `subagent_fork(description, prompt, run_in_background?)` starts a child seeded
  with completed parent turns. The current in-flight turn is excluded.
- `send_message(subagent_id, message)` steers a running direct child with an
  update at its next tool-batch boundary.
- `followup_task(subagent_id, message)` requests a new FIFO task from a direct
  child. It waits behind current work or starts an idle child.
- `interrupt_agent(agent_id)` requests cancellation of a descendant's current
  turn or initialization. Queued messages, descendants, identity, and durable session remain.
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
- Accepted new tasks are persisted and processed in append-order FIFO.
  A started message without a terminal delivery record is replayed after a crash,
  which provides at-least-once rather than exactly-once execution.
- A settled child releases its SDK activation but retains its session and ID.
  The next direct-parent `followup_task` cold-resumes it from the descriptor.
- Only an exact live direct parent handle can send a follow-up.
- An exact live ancestor can interrupt a resident descendant.
- Only the exact resident continuable child can call `report`.
- The defaults are depth 3, eight live child activations per root, and a
  30-second activation-opening deadline. Opening children count toward the cap.
- Child model, effective provider configuration, resolved request auth exposed
  by Pi, and thinking level inherit from the parent at activation. Durable model
  identity and thinking level are restored from the descriptor.
- Child resources include an explicit allowlist of enabled native coding tools
  and the maintained `todo_write` tool when active in the parent. Project settings,
  context, skills, and shell prefixes follow the parent's effective trust decision.
  The descriptor preserves that ceiling; cold activations also respect the current
  root's trust. Interactive question tools are not loaded.
- Reports and settlements use steering at every depth, in per-child order. Late
  results may start an idle-parent turn. Pi's `steeringMode` controls batching:
  `all` admits queued notices together; `one-at-a-time` admits one per turn.
  Retained one-shot parents also receive nested notices.
- Use reports for actionable changes, not routine progress. The final answer is
  delivered automatically in settlement and should not be reported again.
- The sender keeps a durable outbox until the receiver durably accepts the notice.
  A receipt is written before steering; recovery replays receipts missing their
  matching Pi custom message. Root `message_end` is not an acknowledgement boundary.
  Crash recovery is at-least-once, with message IDs preventing duplicate admission.
- Each activation receives fresh model-runtime state. Provider authentication is
  inherited from the parent resolver, with the parent request's in-memory auth
  header as a non-persisted fallback for long-lived OAuth sessions. Effective
  parent API keys override stored child keys. Native OAuth refresh is retained;
  parent and child must resolve the same OAuth credential store.
- Successful foreground work returns full native tool usage. Background and failed
  foreground invocations write deduplicated root billing records for `/pi-usage`,
  including tool and compaction usage. Native Pi footer totals do not include these
  custom background records.
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
- the exact last activation error when a child fails before producing messages;
- `m` to request a new direct-child task and `x` to interrupt the current turn.

Pi branch navigation is blocked while the current session owns live children.
Session replacement drains live SDK activations and reconstructs the durable
catalog for the replacement root.

## Storage

Child sessions use Pi's JSONL session format under:

```text
~/.pi/agent/subagents/sessions/<root-session-id>/*.jsonl
```

The child session contains model-hidden custom entries for:

- `pi-subagents/descriptor-v1` — immutable first-authoritative identity, lineage,
  depth, model, thinking, context mode, tool allowlist, and project-trust ceiling
  (descriptor payload version 2);
- `pi-subagents/inbox-v1` — accepted FIFO work;
- `pi-subagents/delivery-v1` — started and finished delivery records;
- `pi-subagents/control-v1` — durable explicit-interrupt parking and waking;
- `pi-subagents/launch-v1` — branch-aware child ownership;
- `pi-subagents/settlement-v1` — pending and acknowledged report and settlement
  outbox records;
- `pi-subagents/notice-received-v1` — durable notice admission before Pi appends
  the corresponding custom message;
- `pi-subagents/usage-v1` in the root — background invocation charges, replayable
  from completed child delivery records.

Transcript previews parse appended entries incrementally, cache bounded rendered
tails, and strip terminal controls. Pi's pure session parser handles initial loads,
rotation, truncation, and branch ancestors outside the cache, without altering files.

Reading the catalog or a transcript does not activate a cold child. Missing,
corrupt, unsupported, and unavailable launched children appear as diagnostic rows
in both discovery and the dashboard. Dashboard usage aggregates requests and its
duration measures active prompt time rather than wall lifetime.

## Pi 0.84.3 gaps

The implementation keeps these boundaries explicit:

1. Pi has no process-global agent registry, continuation inbox, or generic job
   service. This extension owns the live registry and durable FIFO.
2. Pi cannot attach DSH message-source metadata to a real user message.
   Notices carry provenance in custom-message details and durable receipt records.
3. Pi has no public per-activation `maxTokens` override. Cold activations use the
   restored model's normal token limit.
4. Pi extensions cannot register a browser-side child catalog or composer. The
   complete interface is available in the TUI; RPC mode receives notices but no
   custom dashboard.
5. Pi tears down the extension runtime for reload, new, resume, and fork. Active
   turns are therefore aborted cleanly and durable sessions are reconstructed
   instead of preserving in-memory activations across replacement.
6. Pi does not expose executable parent tool definitions or extension event
   policies through `getAllTools()`. Children therefore recreate the enabled
   native built-ins and this package's maintained `todo_write` tool; other parent
   tool overrides, sandboxes, and permission hooks do not transfer. Restrict the
   native child allowlist when those controls are required.
7. Pi does not persist an exact `turn/end` marker. Fork boundaries use the last
   completed assistant before delegation, or a summary verified against durable
   turn boundaries. Forks reconstruct completed history when a summary includes
   current work.
8. SDK operations that expose cancellation receive the opening signal. Opening
   is deadline-bounded even when an operation ignores cancellation; any late
   driver is disposed. This does not make arbitrary uncooperative tools cancellable.

## Design attribution

The lifecycle, tool semantics, descriptor model, authority rules, continuation
states, reporting contract, and discovery vocabulary are adapted from the MIT
licensed DeepSeek Harness design. See
[`DSH-DESIGN-ATTRIBUTION.md`](./DSH-DESIGN-ATTRIBUTION.md).
