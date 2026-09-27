# Extension presentations

`getPresentation(pi)` discovers a host presentation through
`pi-ui/discover-v2`. Ordinary terminal sessions return `undefined`; their
existing UI remains in use. Desk supplies version 1 and advertises supported
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

Views may include `badges: [{ label, value, description?, compact? }]` for compact facts
beside the conversation. The publishing controller owns their meaning and
updates, just like the full view. Desk shows root badges in its footer and links
back to their views; child-scope badges do not describe the parent session.
`compact: true` keeps an important badge in the collapsed mobile summary;
other badges remain in its expanded details.
Badges are not a parsing contract for terminal status strings.

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

Desk owns transport admission, presentation generations and bounded projection.
Extensions still enforce their domain revisions, validation, permissions and
durable writes. The contract is implemented in
[`pi-desk/src/host/presentation.ts`](../pi-desk/src/host/presentation.ts).
