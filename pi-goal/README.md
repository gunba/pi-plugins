# Pi Goal

Pi Goal adds one durable, branch-local completion goal to a Pi session. It can continue substantial work through bounded, same-session model rounds while keeping human controls and terminal reporting explicit.

Built for Pi **0.85.1**.

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
- `blocked` reports during an automatic goal round require at least three admitted rounds. Outside an automatic goal round, a blocker can be recorded immediately.
- Each validated continuation writes a non-context custom admission entry containing its exact identity and rendered prompt. Replay counts that entry, so the visible custom round message can be pruned from context without changing goal state.
- Visible continuation messages carry the model prompt and transcript presentation. Their objective is JSON-quoted, so multiline and tag-like text remains data inside `<goal_round>`.
- `agent_settled` drives at most one next round. An in-memory reservation prevents duplicate dispatch.
- Autonomous completion and blocking add a closing instruction for the model’s user-facing wrap-up.
- `/goal` output is a non-model custom entry. Commands, rounds and tool calls retain their transcript renderers. Goal state appears collapsed in the shared Work panel, alongside todos and subagents. Expand its section to see the objective, activation, round count and blocker.

## Agent controls

Goal tools operate on the current session branch regardless of input source or
agent role. They are available during autonomous rounds, after compaction or
resume, and in managed children. Updates still require the exact goal ID and
revision, and the store validates state transitions.

A restored active goal is **disarmed** until resumed through the tool or command.
Managed children can maintain their own branch-local goals; their enclosing
runtime, rather than this plugin, controls continuation. Child tools do not
address a parent's goal.

## Pi semantic gaps

Pi 0.85.1 does not expose several DSH host primitives. This extension therefore cannot provide security- or crash-equivalent behaviour in these areas:

- Custom messages lose typed source attribution when Pi converts them to model input. Another trusted extension can imitate a goal message.
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
