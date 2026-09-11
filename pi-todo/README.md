# pi-todo

A Pi 0.85.1 extension that provides the DSH-compatible `todo_write` tool and a compact task summary in the shared Work panel above the editor.

## Behaviour

- `todo_write` accepts the complete ordered list of `{ content, status }` items. Every successful call replaces the previous list. The parameter root remains open like DSH, but each item is closed to additional fields.
- Status is exactly `pending`, `in_progress`, or `completed`. Raw string fields are checked before Pi's schema conversion, so numbers and booleans are not coerced into accepted strings.
- Content is trimmed, blank content is rejected, and trimmed content must be unique with case-sensitive comparison.
- Parallel `in_progress` items are allowed by default.
- Successful writes and next-agent-run clears are stored as hidden custom session entries. Detached, frozen snapshots prevent later argument, result, or branch-entry mutation from changing the projected list. State therefore follows `/resume`, `/reload`, and `/tree` branch navigation without entering model context.
- The task summary remains visible after the agent settles and clears when the next agent run starts. `/work todos` opens every item in a bounded, scrollable overlay. Native `Ctrl+O` continues to expand tool transcript output only.
- Stored content remains exact. Summaries flatten whitespace and encode terminal controls; the detail overlay preserves line breaks and safely displays control characters. Tool transcript renderers retain their existing safe encoding.
- Empty lists and cleared state do not show a widget.

Pi 0.84.2 does not expose an event that distinguishes a queued follow-up turn from an ordinary tool or steering continuation. The extension therefore clears at the next `before_agent_start` boundary; a queued follow-up within the same low-level run can retain the standing list longer than DSH.

The model receives this exact success acknowledgement:

```text
Updated todo list: N pending, N in progress, N completed.
```

## Install

The repository root package loads this extension automatically. For isolated development, run:

```sh
pi -e C:/Users/Jordan.Graham/.pi/agent/git/github.com/gunba/pi-plugins/pi-todo
```

## Design attribution

The compatibility contract and interaction design are based on DeepSeek Harness's [`@deepseek-ai/dsh-tool-todo`](https://github.com/deepseek-ai/deepseek-harness/tree/99f6f02fecdb7dff40c3fbc9470f5907c29f74ca/packages/todo/tool-todo), Copyright © 2026 DeepSeek, licensed under the MIT License. This package is an independent TypeScript implementation for Pi and does not copy the DSH source implementation.

## Test

From the parent repository:

```sh
node --test pi-todo/tests/*.test.mjs
npx tsc --noEmit
```
