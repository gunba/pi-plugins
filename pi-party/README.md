# Party

Link independent main-agent sessions by typing the same room ID in each:

```text
/party 1
```

Only those sessions become peers. No session list or conversation history is
shared automatically. The Party work-panel section shows members, activity
and unread messages.

- `/party`: show the current room.
- `/party chat`: open a live, scrollable conversation viewer for the current room.
- `/party leave`: leave and revoke queued messages for this membership.
- `/party resume`: resume delivery and reset the automatic-delivery budget.
- `party_members`: list linked peers.
- `party_send`: send to a member ID, an unambiguous ID prefix, or `all`.
- `party_read`: read queued messages, including those held by the delivery limit.

Messages are peer context, not human instructions or approval. The tools
cannot join a room or change another session's goal. SDK children do not
register this extension.

`party_members` is read-only and never wakes peers. `party_send` with `to: "all"`
broadcasts to every other member of the current room. Tool rows show recipient
names, a message preview and wake status; Ctrl+O expands the formatted message.
Incoming messages also show a preview in the transcript.

## Conversation viewer

In interactive Pi, `/party chat` shows the room's retained sent and received
messages, including communication between other members, with conversation names,
local timestamp, delivery status and whether a wake was requested. A broadcast
appears once per recipient. `Delivered` means recorded by the receiving session,
not a human read receipt or a completed reply. Message bodies render Markdown, including
lists, links and code blocks. Internal message and session IDs are not displayed.

Use arrows or the mouse wheel to scroll, Page Up/Down to move a screen, and
Left/Right to page through history. Home opens the oldest retained messages;
End returns to the live tail. New messages follow automatically at the live
tail; scrolling back holds your place. Escape closes the viewer. History loads
20 complete messages at a time, without shortening their stored text.

Opening, scrolling and refreshing the viewer do not send messages, arm delivery,
mark inbox messages as delivered or spend wake budget. It closes on reload,
branch navigation, leave or shutdown. History uses the existing retention:
admitted messages older than seven days are removed when another message is sent,
and leaving or changing rooms revokes queued messages.

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
