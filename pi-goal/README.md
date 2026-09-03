# Pi Goal

Pi Goal adds one durable, branch-local completion goal to a Pi session. It can continue substantial work through bounded, same-session model rounds while keeping human controls and terminal reporting explicit.

Built for Pi **0.84.2**.

The repository root package loads this extension automatically. For isolated development, run:

```bash
pi -e C:/Users/Jordan.Graham/.pi/agent/git/github.com/gunba/pi-plugins/pi-goal
```

## Use

```text
/goal [<objective>|clear|edit <objective>|pause|resume]
```

- `/goal` shows the current state.
- `/goal <objective>` creates a goal. It does not replace unfinished work.
- `/goal edit <objective>` changes the current objective. Against a completed goal, it creates a fresh goal.
- `/goal pause` stops automatic continuation.
- `/goal resume` activates a paused, blocked, or restored goal.
- `/goal clear` writes a revisioned tombstone and removes the current goal.

The extension also registers three sequential model tools:

- `get_goal`
- `create_goal`
- `update_goal`

`update_goal` uses exact goal ID and revision compare-and-set values. Its actions are `edit`, `pause`, `resume`, `complete`, and `blocked`. Empty strings and numeric zero are accepted only as ignored fillers in conditional update fields, matching the DSH tool contract.

## Behaviour

- One goal exists on each selected session branch.
- Every non-clear mutation stores a complete version-1 snapshot in a custom entry. Clear stores a revisioned tombstone.
- Replay rejects malformed records, revision gaps, illegal transitions, reused IDs, timestamp or counter regressions, and stale or skipped rounds.
- Corrupt selected-branch history disables the goal instead of accepting a valid prefix.
- Durable phases are `active`, `paused`, `blocked`, and `complete`.
- Activation is process-local. Session start, reload, resume, fork, and tree navigation restore active goals as disarmed.
- The default continuation cap is 256 rounds. A per-goal cap can override it.
- Autonomous `blocked` reports require at least three admitted rounds. A direct human turn can block earlier.
- Each validated continuation writes a non-context custom admission entry containing its exact identity and rendered prompt. Replay counts that entry, so the visible custom round message can be pruned from context without changing goal state.
- Visible continuation messages carry the model prompt and transcript presentation. Their objective is JSON-quoted, so multiline and tag-like text remains data inside `<goal_round>`.
- `agent_settled` drives at most one next round. An in-memory reservation prevents duplicate dispatch.
- Autonomous completion and blocking add one no-tools closing instruction for the model’s user-facing wrap-up.
- `/goal` output is a non-model custom entry. Goal state, commands, rounds, and tool calls have compact TUI renderers, status, and widget presentation.

## Authority

Pi Goal records ordered input markers for both human and extension sources. It grants direct-human authority only when a message for that delivery class has content matching an `interactive` or `rpc` marker. One match admits the whole current agent run, including a group of human messages that Pi flushes together after compaction. The grant lasts until `agent_settled`, so tool calls, subagent notices, scheduler messages, and later context normalization cannot revoke it. Steering inputs are matched before queued follow-ups, mirroring Pi's queue order, so extension steering cannot consume an earlier human follow-up marker. Immediate skill and template expansion is rebound through `before_agent_start`. A transformed queued input fails closed because Pi exposes no equivalent boundary when it later leaves the queue.

Direct-human turns may let the model create, edit, pause, resume, complete, or block a goal. An automatic round may only complete or block the exact goal revision and admitted round that the extension reserved; that authority also lasts until the round's agent run settles. Goal tools do not grant direct-human mutation authority inside Pi Subagents child processes. Arbitrary context values are fingerprinted without JSON serialization; unsupported values clear pending input markers but cannot revoke authority that the current run has already admitted.

This is the strongest authority boundary exposed by Pi 0.84.2. Extensions share the Pi process and are trusted code.

## Pi semantic gaps

Pi 0.84.2 does not expose several DSH host primitives. This extension therefore cannot provide security- or crash-equivalent behaviour in these areas:

- Custom messages lose typed source attribution when Pi converts them to model input. Another trusted extension can imitate a goal message.
- Registered command handlers run before Pi emits `input` and receive no source metadata. A trusted extension can therefore invoke `/goal` controls through `sendUserMessage(..., { expandPromptTemplates: true })`; source isolation for `/goal` requires a Pi host change or replacing the registered command path.
- Human queue priority and `hasPendingMessages()` are not atomic with continuation dispatch.
- Extensions cannot reserve or reject a message at a cancellable pre-model-step fence.
- `appendEntry()` has no explicit flush, and a brand-new session may not reach disk before its first assistant message.
- `sendMessage()` returns no enqueue result. The driver relies on a matching `message_end` event for durable admission, and asynchronous queue failures cannot be distinguished from a delayed append.
- Extensions cannot install pre-append session invariants or await a continuation-driver shutdown handle.
- The wrap-up instruction is injected through Pi’s `context` event rather than a tool-bound deferred-context primitive.
- Pi has no independent extension system-prompt section. The shared goal policy is attached identically to all three goal tools so filtering out `get_goal` alone cannot remove it; filtering out every goal tool necessarily removes the policy.
- Command handlers have no portable return channel in print or JSON mode; transcript cards are a TUI feature.

Run unattended goals only in an appropriately restricted environment.

## Design attribution

The user-visible design and state-machine semantics are based on the Goal packages in [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) at commit `99f6f02fecdb7dff40c3fbc9470f5907c29f74ca`. DeepSeek Harness is Copyright © 2026 DeepSeek and licensed under the MIT License.

This package is an independent TypeScript implementation for Pi. It does not copy the DSH implementation.

## Development

From the repository root:

```bash
npx tsc --noEmit -p pi-goal/tsconfig.json
node --test pi-goal/tests/*.test.mjs
```
