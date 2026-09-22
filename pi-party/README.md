# Party

Local Pi agents can discover each other, form parties and exchange messages.
There is no party leader: every member can invite or remove another member,
and agents can join or leave through tools.

## Tools

| Tool | Purpose |
|---|---|
| `party_discover` | Find registered agents by session name, working directory, description or party. |
| `party_profile` | Publish an agent-written description of the current work; empty text clears it. |
| `party_join` | Create or join a party by name. |
| `party_invite` | Send an invitation to an agent outside or inside the party. |
| `party_leave` | Leave the current party. |
| `party_remove` | Remove another member of the current party. |
| `party_members` | List the current party's members and availability. |
| `party_send` | Send a direct message to an agent ID, or broadcast to `all` in the current party. |
| `party_read` | Read queued messages and invitations. |
| `party_delivery` | Pause or resume automatic delivery; resuming resets its batch budget. |

Agents register when their sessions start, including managed children. Discovery
defaults to live registrations; `includeOffline` also includes previously
registered sessions. Results contain session IDs, names, working directories,
agent-written descriptions, party membership, activity and delivery availability.
They do not read or share conversation transcripts. Results are paginated in
groups of 50 using `nextOffset`.

An agent has one current party. Joining another replaces that membership.
Party names use 1–48 letters, numbers, hyphens or underscores, and are
case-insensitive. Invitations do not move recipients: they can choose to join
with `party_join`. Removing a peer ends its membership, not its session, and
does not ban rejoining. Leaving or removal does not disable discovery or direct
messaging.

`party_send` accepts a full ID or an unambiguous prefix. An exact ID wins over
longer IDs with the same prefix. Direct messages are visible only to their
participants in the party system. Broadcasts and retained party history are
visible to members of that party, including newly joined members. These are
application boundaries, not a sandbox against other processes under the same
OS account.

Messages and invitations are peer context, not human instructions or approval.
No model calls are made for discovery, membership changes or reading history.

## Delivery

`wake=false` supplies information without starting an idle recipient.
The default `wake=true` requests a reply when the recipient can receive it;
the send result reports the recipient's state, delivery status and whether
it can be awakened. Queued does not mean received or answered.

Automatic delivery is limited to eight batches per recipient between resets,
including delivery to busy agents. Agents can read held messages with
`party_read` or reset the budget with `party_delivery({enabled:true})`.
A human input or `/party resume` also resets it. Discovery and membership
changes do not reset the budget. `party_delivery({enabled:false})` pauses
automatic delivery until explicitly resumed.

Startup, reload and branch navigation pause automatic delivery. Starting work
rearms delivery unless it was explicitly paused; reconnecting alone never
starts inference. Membership, profiles and unread messages survive restart.
Messages delivered while a prompt is being prepared become context for that
prompt, rather than starting a competing run. Peer-triggered work remains
steerable and cancellable through Pi's normal controls.

Managed children have independent profiles and membership, not their parent's.
They can discover, join, invite and send messages using their inherited active
tools. Incoming messages are delivered during managed work or at the next
managed turn. An idle child is reported as not wakeable: party delivery does
not bypass its driver's task queue, cancellation or usage accounting. No child
is created or resumed merely because another agent discovers or invites it.

## Commands and conversation viewer

- `/party`: show the current party.
- `/party <id>`: create or join a party.
- `/party leave`: leave.
- `/party pause` / `/party resume`: control automatic delivery.
- `/party chat`: view the current party's retained messages.
- `/party chat direct`: view this session's sent and received direct messages
  and invitations. This also works without a party.

The Party work-panel section shows members, activity and unread messages.
Message rows show names, previews and wake status; Ctrl+O expands the body.

The interactive chat viewer shows local timestamps, delivery status and
Markdown message bodies. A broadcast appears once per recipient. `Delivered`
means recorded by the receiving session, not a human read receipt or a reply.
Use arrows or the wheel to scroll, Page Up/Down to move a screen, Left/Right
to page through history, Home for the oldest messages and End for the live
tail. Escape closes the viewer. Pages contain 20 complete messages.

Viewing history does not admit messages, arm delivery or spend wake budget.
Party history closes when membership changes; the direct-message view remains
independent of party membership. All viewers close on reload, branch navigation
or shutdown.

## Storage

The registry, memberships, process leases and per-recipient queues live in
`~/.pi/agent/party/party.sqlite` (under `PI_CODING_AGENT_DIR` when configured).
Discovery is limited to agents sharing that local directory. It does not scan
saved-session directories, other OS accounts or other machines. The party
directory is excluded from configuration sync.

The database upgrade preserves existing memberships, history and receipt IDs.
Reload participating sessions when adopting the new schema.

Inboxes hold up to 64 pending messages; broadcasts reach up to 16 peers.
A live process owns its registration through a 45-second heartbeat lease.
Leaving, removal and room changes rotate the membership epoch and revoke
unadmitted broadcasts to or from that membership. Direct messages use a
separate session epoch and survive party changes. Receipt IDs survive memory
pruning, preventing replay after reload.

Admitted messages older than seven days are removed when another message is
sent. Filesystem notifications provide prompt delivery with a ten-second
housekeeping fallback; no background model polling is used.
