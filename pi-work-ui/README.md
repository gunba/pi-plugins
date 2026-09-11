# Work panel

Goal, Todos and Subagents share one compact panel above Pi's editor. Each present section gets one row: state first, then a width-clipped preview. The panel uses at most four rows, including its `/work` hint. It does not replace the editor, working indicator or footer.

## Read the details

- `/work` opens a collapsed section selector.
- `/work goal`, `/work todos` or `/work subagents` opens that section directly.
- In the selector, Up/Down selects a section; Enter or Space expands it.
- In a section, Up/Down and Page Up/Page Down scroll; Home/End jumps; Enter or Space collapses.
- Escape closes the overlay. Selection, confirmation, cancellation and page keys respect Pi's configured selection bindings.
- `d` in the expanded Subagents section opens the existing dashboard. `/subagents` remains available directly, including its permissions commands, transcripts and actions.

Details use a fresh overlay, capped at 24 rows and 70% of terminal height. Full goal text remains reachable by scrolling, regardless of its length. Viewing never changes, resumes or re-arms a goal. Native Ctrl+O still controls tool transcript output, not the standing panel. No global shortcut is registered.

## Integration

This module is bundled with the repository, not a separate auto-loaded extension. Each consumer calls `ensureWorkUi(pi)` during factory registration. A synchronous event-bus discovery claim registers `/work` and lifecycle hooks once per underlying bus, even though Pi gives extensions distinct event facades. An individual goal/todo/subagents package can be loaded alone from the checkout; it still imports this sibling module.

After the shared `session_start` or `session_tree` hook, a consumer calls `ui.source("goal" | "todos" | "subagents")` and publishes a factual `WorkSection`. Async producers must capture that source lease in their runtime closure. Replacing a source, changing branches, or shutting down invalidates its old lease. No model calls, timers or persistence writes are used. Only TUI mode installs component factories; RPC and non-interactive modes retain source tool behavior without a terminal panel.

Do not restore UI expansion from session entries, or reuse disposed overlays. Source packages retain sole responsibility for their durable state and permissions.

## Checks

```sh
node --test pi-work-ui/tests/*.test.mjs
npm run typecheck
```
