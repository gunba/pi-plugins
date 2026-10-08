# Extension presentations

`getPresentation(pi)` discovers a host presentation through
`pi-ui/discover-v2`. Ordinary terminal sessions return `undefined`; their
existing UI remains in use. Desk supplies version 2 and advertises supported
capabilities.

```ts
const presentation = getPresentation(pi);
if (presentation?.capabilities.includes("details")) {
  presentation.publish("example", {
    kind: "details",
    title: "Example",
    surface: "settings",
    data: { fields: [{ label: "State", value: controller.state() }] },
    actions: [{ id: "refresh", label: "Refresh" }],
  }, { refresh: () => controller.refresh() });
}
```

The controller remains the state owner. Views contain plain data; action,
interaction and transcript callbacks stay in the host. This module has no
browser or terminal dependency at runtime.

Views may include `badges: [{ label, value, description?, compact?, control? }]`
for compact facts beside the conversation. The publishing controller owns their
meaning and updates. Desk shows root badges in its footer; child-scope badges
do not describe the parent session. `compact: true` keeps a badge visible on
mobile. `control` is the action ID of a toggle in that view's `data.controls`;
clicking the badge invokes the same control directly, with the next boolean
value and the normal view revision/action lock. Other badges are read-only.
Badges are not a parsing contract for terminal status strings.

## Settings and resources

An owner with a native resource loader may expose `resources()`: metadata for that
session's loaded instructions, skills, prompts and extensions, with read-only
markers for managed files. It does not expose file contents or another scope's
resources. The capability retires with its presentation lease.

`pi-config` publishes `kind: "configuration"` for its browser. The controller owns
inventory search, bounded pages, protected previews and file actions; the browser
owns input drafts and display selection. Effective values come from Pi's
`getSettings()`, not a parallel settings store.

## Side conversations

A host advertising `conversations` renders `kind: "conversation"` views with
`UiConversation` data: an opaque registered
transcript handle, status/activity, an active flag, optional details, and the
scope whose questions it owns. Desk shows these views in its Agents pane, not
as duplicate Work cards. Selection, drafts and reading positions belong to the
browser; the controller still owns the conversation and permissions.

Message actions advertise `input: "message"` and a `delivery` of `steer` or
`followUp`. Their callback receives a string and resolves after accepting that
message, not after running its task. Unlike interactive actions, the host waits
for this admission result. A failed or uncertain reply must not clear the draft
or cause an automatic resend. Other actions retain the interactive admission
path and can open native questions.

Use `batch(() => { ... })` for synchronous collection updates. It publishes one
snapshot after the group instead of a growing snapshot per item. Each view keeps
its own revision, action lock and failure state.

## Lifetime

- A discovered presentation belongs to that extension runtime. Replacement or
  reload retires it; discover a new one during the new lifecycle.
- `publish(id, undefined)` removes a view. `open(id, section)` requests its
  surface. The host supplies revisions and rejects stale action dispatch.
- `request()` resolves to an answer or `null` on cancellation, expiry or
  retirement. Abort signals and timeouts belong to the request.
- A child scope has its own native UI context and questions. Install it into
  the child's extension API, then close it when that activation ends.
- Transcript registration supplies read-only native branches and events, not
  another message store. Closing its handle retires access.
- `runCommand()` invokes a registered extension command through the normal
  interactive SDK path. It is not arbitrary shell execution or a core-TUI
  command emulator.

## Maintenance

A host may expose `registerMaintenance(owner)`. The owner identifies its scope IDs,
checks admission in `inspect()`, and implements `hold(id)`, `restore(id)` and
`release(id)`. It retains its own native sessions, cursor saves and continuation
receipts. These callbacks are local capabilities, not browser data or a queue-export
API. Close the registration when its runtime ends.

During a hold, `suspended` is true. Pending notices and autonomous work remain
with their producer. A restore runs while the parent is suspended; release resumes
only confirmed interrupted work. Unowned scopes and unsupported pending input
refuse maintenance rather than silently dropping context.

Desk owns transport admission, presentation generations and bounded projection.
Extensions still enforce their domain revisions, validation, permissions and
durable writes. The contract is implemented in
[`pi-desk/src/host/presentation.ts`](../pi-desk/src/host/presentation.ts).
