# Party

Link independent main-agent sessions by typing the same room ID in each:

```text
/party 1
```

Only those sessions become peers. No session list or conversation history is
shared automatically. The Party work-panel section shows members, activity
and unread messages.

- `/party`: show the current room and member ID.
- `/party leave`: leave and revoke queued messages for this membership.
- `/party resume`: resume delivery and reset the automatic-delivery budget.
- `party_members`: list linked peers.
- `party_send`: send to a member ID, an unambiguous ID prefix, or `all`.
- `party_read`: read queued messages, including those held by the delivery limit.

Messages are peer context, not human instructions or approval. The tools
cannot join a room or change another session's goal. SDK children do not
register this extension.

`party_send` normally requests a reply. `wake=false` supplies information
without starting an idle recipient. Automatic delivery is limited to eight
batches between human inputs or explicit `/party resume` commands, including
delivery to busy sessions. This bounds automatic peer-response loops.

Membership survives restart. Startup, reload and branch navigation pause
delivery until a human message or `/party resume`; reconnecting alone never
starts inference.

## Storage

Membership, process leases and per-recipient queues live in
`~/.pi/agent/party/party.sqlite`, independently of scheduler storage.
The directory is excluded from configuration sync.

Inboxes hold up to 64 pending messages; broadcasts reach up to 16 peers.
A live process owns a membership through a
45-second heartbeat lease. Room changes and leave/rejoin rotate membership
epochs, preventing delivery into a different room. Native message IDs are
retained through memory pruning to avoid replay after reload.

Filesystem notifications provide prompt delivery, with a ten-second
housekeeping fallback. No background model polling is used.
