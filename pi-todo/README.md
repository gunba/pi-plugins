# pi-todo

A Pi 0.84.2 extension that provides the DSH-compatible `todo_write` tool and a compact standing task list above the editor.

## Behaviour

- `todo_write` accepts the complete ordered list of `{ content, status }` items. Every successful call replaces the previous list.
- Status is exactly `pending`, `in_progress`, or `completed`.
- Content is trimmed, blank content is rejected, and trimmed content must be unique with case-sensitive comparison.
- Parallel `in_progress` items are allowed by default.
- Successful writes and next-agent-run clears are stored as hidden custom session entries. State therefore follows `/resume`, `/reload`, and `/tree` branch navigation without entering model context.
- The standing widget remains visible after the agent settles and clears when the next agent run starts. Use Pi's tool expansion control (normally `Ctrl+O`) to show or hide item rows.
- Empty lists and cleared state do not show a widget.

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
