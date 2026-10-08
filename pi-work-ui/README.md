# Work view

Plan, Subagents and Party share one compact panel above Pi's editor.
Each section shows its state before the clipped preview.
The Plan summary shows objective/current step, progress and continuation mode.
Round usage, limit, revision and all steps are in the detail view.

Use `/work` or `/work plan|subagents|party` to open the modal.
In fullscreen mode, clicking a summary row opens that section.

The modal works in regular and fullscreen terminal modes:

- **Left/Right, Tab/Shift+Tab**: change section
- **Up/Down, Page Up/Down, Home/End**: scroll details
- **Enter**: open the section's management screen when offered
- **Esc or Ctrl+C**: close

Fullscreen also supports clicking tabs and using the mouse wheel. Narrow views
show the selected section and its position. Details update while open; closing
restores editor focus and the existing draft.

Subagents reuses `/subagents` for transcripts, follow-ups and interruption. Party
opens the existing chat view. Other domain commands and tools remain available. Ctrl+O controls native tool output.

## Integration

This shared module is not a separate auto-loaded extension. Consumers call
`ensureWorkUi(pi)` during factory registration. Event-bus discovery installs
one set of lifecycle hooks and one `/work` command per underlying bus.

After `session_start` or `session_tree`, obtain a generation-bound source with
`ui.source("plan" | "subagents" | "party")`. Replacing a source,
changing branches, or shutting down invalidates old publishers and pointer
callbacks. Navigation is display state only: viewing does not resume plans,
write session history or start inference.

Sections publish complete plain-text details and can provide a `manage` action.
Only explicit activation invokes that action, after closing the detail modal;
its return reopens the selected section. Actions are fenced by the publisher's
lease. Session changes close the modal and invalidate pending returns.

The modal uses up to 85% of the terminal height, with native text wrapping and
scroll state. RPC and non-interactive tools do not mount terminal components.

## Checks

```sh
node --test pi-work-ui/tests/*.test.mjs
npm run typecheck
```
