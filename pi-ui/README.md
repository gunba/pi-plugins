# Extension presentations

`getPresentation(pi)` discovers a host presentation through
`pi-ui/discover-v1`. Ordinary terminal sessions return `undefined`; their
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
