# Party

## Pi Desk

The Party card provides discovery, profiles, membership, invitations, direct
and party messages, removal, and delivery controls. Sending offers an explicit
choice between queueing quietly and requesting a reply. Invitations do not
change membership.

The sidebar groups agents by party under their computer. **New party** creates
a party with selected registered agents; the group controls add or remove members.
The membership dialog lists agents from all connected computers. These are direct
user membership changes, not invitations; ownership, paused delivery and wake
budgets stay with each agent. **Close party agents** asks for confirmation, then
stops members on their owning computers and reports each result. Closing retains
saved native history and membership. Removing the last member ends the group but
does not stop an agent.

History is paged and direct messages are participant-scoped. Opening a message
does not deliver it to Pi, consume its wake budget, or start an agent. Long
messages have a paged full-text view. The app and terminal use the same party
store and delivery controller. Computers signed into the same Desk account share
discovery, parties and encrypted message delivery. Without Desk, local parties
continue to work independently.

Pi agents can discover each other, form parties and exchange messages.
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
| `party_remove` | Remove another member of the current party, including on a connected computer. |
| `party_resume` | Reopen an existing party member on its own Desk computer. |
| `party_create` | Ask for user approval, then create an agent and queue its task in the current party. |
| `party_fork` | Ask for user approval, then fork completed context into an independent agent in the same party. |
| `party_members` | List the current party's members and availability. |
| `party_send` | Send a direct message to an agent ID, or broadcast to `all` in the current party. |
| `party_read` | Read queued messages, invitations, delivery receipts and lifecycle outcomes. |
| `party_delivery` | Pause or resume automatic delivery; resuming resets its idle-wake budget. |

Agents register when their sessions start, including managed children. Discovery
defaults to live registrations; `includeOffline` also includes previously
registered sessions. Results contain session IDs, names, working directories,
agent-written descriptions, party membership, activity and delivery availability.
They do not read or share conversation transcripts. Results are paginated in
groups of 50 using `nextOffset`. Remote IDs use `session-id@computer-id`; their
native session prefix remains usable when unambiguous. Results identify the
computer separately. `computers` lists connected computer IDs; `local` means this computer.

Resume, creation and forks require a running Desk host. `party_fork` stays on the
source computer and directory, preserves native model/reasoning and branch context,
and excludes the executing assistant turn. It leaves the parent running; its tools
are not replayed. Like creation, a fork requires approval in the human interface.

`party_resume` targets an existing
member, uses the native saved-session path, and preserves explicit delivery pauses
and wake budgets. Already-running sessions are not replaced. A resumed unpaused
session can receive queued peer context through its normal delivery controller.
Managed children resume through their owning parent driver, including its saved
root session when the driver is suspended. Their task queue, cancellation and
usage accounting remain native. If no owning parent reference is available,
resume the parent conversation first; Desk never opens a child file as a root.

`party_create` accepts a name, working directory, task and optional computer ID.
It uses the destination computer's model defaults. Pi asks the user to approve the
actual task before queueing it; peer messages and tool arguments cannot grant that
approval. The tool is model-only and is unavailable inside codemode scripts.
Creation without an interactive Pi or Desk UI is rejected.

Lifecycle requests have bounded lifetimes and durable receipts. Duplicate dispatch
returns the recorded outcome, not another agent. Interrupted operations are not
replayed after a host restart; inspect the agent before retrying an uncertain
outcome. Changing party membership fences stale requests.

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
the send result records the wake request and reports the recipient's state,
delivery status and whether it can be awakened. Held delivery reasons are shown
with the send result; history distinguishes reply requests from silent messages.
Queued does not mean received, started or answered. Cross-computer receipts report whether
the receiving inbox accepted the message, or why delivery failed. Sending to a
disconnected computer fails explicitly rather than silently queueing it.

Automatic idle starts are limited to eight per recipient between resets.
Coordination delivered to working agents, silent messages and context attached
to a human prompt do not spend that budget. Held wake requests do not block later
silent messages; explicit delivery pauses still hold both. Managed child starts are counted by
their owning driver. Party controls and the Desk sidebar show when a wake is held.
Agents can read held messages with `party_read` or reset the budget with
`party_delivery({enabled:true})`.
A human input or `/party resume` also resets it. Discovery and membership
changes do not reset the budget. `party_delivery({enabled:false})` pauses
automatic delivery until explicitly resumed.

Startup, reload and branch navigation pause native automatic delivery. Starting
work rearms it unless explicitly paused. In Desk, a new wake-requesting message
from a current party member can resume an interrupted open workspace session or
its suspended children. Reconnecting, discovery and invitations alone do not
start work; explicitly closed workspace conversations stay closed. Membership,
profiles and unread messages survive restart.
Messages delivered while a prompt is being prepared become context for that
prompt, rather than starting a competing run. Peer-triggered work remains
steerable and cancellable through Pi's normal controls.

Managed children have independent profiles and membership, not their parent's.
They can discover, join, invite and send messages using their inherited active
tools. Incoming messages are delivered during managed work or at the next
managed turn. With an available owning driver, a wake-requesting party message
queues an idle child's next turn. Explicit pauses and the eight-start budget are
preserved, and repeated delivery does not queue another turn. Native task queues,
cancellation and usage accounting still apply. Without an owning driver, use
`party_resume` or resume the parent conversation. Discovery and invitations do
not create or resume a child.

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
Local discovery uses that directory. Desk adds an account-scoped remote directory
cache and a durable outbox in the same database; remote agents never acquire local
process ownership. Discovery does not scan saved-session files or other OS accounts.
Explicit resume resolves the registered native ID through saved references or Pi's
`SessionManager.findById`, without loading the whole session catalogue. Owning
parent references come from the native child driver. Existing open workspace
roots can also recover these references from their first-party child catalogue
filenames; full child transcripts are not loaded for discovery.
The party directory is excluded from configuration sync.

Device credentials, purpose-bound signed handshakes and short membership leases
authorize encrypted host-to-host party channels. The broker forwards opaque
frames; party peers cannot access the browser control API. A disconnect expires
remote presence, and changing Desk accounts clears the remote cache and rejects
undelivered traffic from the previous account.

The database upgrade preserves existing memberships, history and receipt IDs.
Reload participating sessions when adopting the new schema.

Inboxes hold up to 64 pending messages; broadcasts reach up to 16 peers.
A live process owns its registration through a 45-second heartbeat lease.
Leaving, removal and room changes rotate the membership epoch and revoke
unadmitted broadcasts to or from that membership. Direct messages use a
separate session epoch and survive party changes. Receipt IDs survive memory
pruning, preventing replay after reload.

Admitted messages and settled outbound history older than seven days are removed
when another message is sent. Filesystem notifications provide prompt delivery with a ten-second
housekeeping fallback; no background model polling is used.
