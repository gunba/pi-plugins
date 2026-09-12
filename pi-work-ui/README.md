# Work panel

Goal, Todos, Subagents and Party share one compact panel above Pi's editor.
Each section starts collapsed, with its state before the clipped preview.

In Pi's fullscreen mode, click a section header to expand or collapse just that
section. Other sections keep their state. Tool results elsewhere in the
transcript use Pi's native per-result mouse expansion.

Keyboard controls work in either terminal mode:

- **Alt+1**: Goal
- **Alt+2**: Todos
- **Alt+3**: Subagents
- **Alt+4**: Party
- **Alt+Page Up/Down**: page the last selected section

Use the mouse wheel over expanded details, or click the left/right halves of
the page indicator. Section headers remain visible while details are paged.
Text selection and editor focus remain with Pi. Ctrl+O controls native tool
output, not this panel. `/subagents` still opens its full management dashboard.

Pi 0.85.1 supports experimental fullscreen mode. Select it through `/settings`
for an immediate change, or start with `pi --tui-mode fullscreen`.

## Integration

This shared module is not a separate auto-loaded extension. Consumers call
`ensureWorkUi(pi)` during factory registration. Event-bus discovery installs
one set of lifecycle hooks and shortcuts per underlying bus.

After `session_start` or `session_tree`, obtain a generation-bound source with
`ui.source("goal" | "todos" | "subagents" | "party")`. Replacing a source,
changing branches, or shutting down invalidates old publishers and pointer
callbacks. Expansion is display state only: viewing does not resume goals,
write session history or start inference.

Expanded details occupy at most 24 rows and half the terminal height, shared
between open sections. Full text remains reachable through paging. Only TUI
mode mounts the component; RPC and non-interactive tools behave unchanged.

## Checks

```sh
node --test pi-work-ui/tests/*.test.mjs
npm run typecheck
```
