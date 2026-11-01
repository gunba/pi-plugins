# Home

Home is a shared canvas and one persistent Pi conversation on the workspace server
(the computer that keeps conversation copies). Its model is
`openai-codex/gpt-6.1-terra`, with low reasoning, selected from the same model store
as any Desk conversation. Local-only Desk keeps Home on that computer.

The quest log remains authoritative. Home's `home_quest` tool can manage the whole
log for the user; existing agents' `quest_*` tools and the temporary Dot connector
continue to use it. Completing an agent's quest still notifies that agent.

## Canvas and conversation

Home uses the same `AgentSpec`, RFC 6902 patch transaction and json-render React
surface as Work. Its catalog adds `Canvas`, `Blob`, `Pill`, `Label` and `Connector`.
Shapes are bounded geometry, not model-authored SVG or HTML. Display text supports
`$state` bindings. The host supplies quest and live-work values separately, so a
bound status can update without a model turn.

The host debounces quest, live-work and drag changes into turns in the existing
Home conversation. Token deltas and usage changes do not trigger layout requests.
Every scene patch compares its revision with the current revision inside a SQLite
transaction. Drags persist as position preferences and survive later arrangements.
An explicit request to move a pinned item can release that preference.

Clicking an item opens its quest details, conversation, published file or HTTP(S)
link. Other changes go through the composer. It supports files, dictation and a
saved delivery receipt, using normal Desk uploads and input admission. The latest
assistant response appears above it; **History** opens the complete native
conversation, including questions, approvals, tool activity and recovery controls.
The last turn's token cost is shown in the header.

The same canvas supports pointer dragging, keyboard movement, panning and pinch
zoom. Colours come from Desk's light and dark theme tokens.

## Assistant capabilities

| Former Dot capability | Home path |
| --- | --- |
| Messages, attachments, dictation, unread state, full history | Native Pi conversation, Home composer, Desk uploads/dictation and shared seen state |
| Delivery receipts and recovery | Durable Home admission envelope plus Desk's existing input ledger; uncertain sends retain their ID |
| List computers and agents | Normal `agent_list` tools |
| Start, resume and message conversations | Normal agent tools and Desk lifecycle; existing approvals remain in force |
| Receive agent replies and wake on work | Normal agent messaging in the persistent Pi worker |
| Read/add/edit/finish/reschedule quests, repeats and working hours | Existing quest log through `home_quest`; no separate task database |
| Scheduled and recurring work | Normal `watch` tool; recurring jobs re-arm an absolute `until` on every wake |
| Gmail research and drafting | Workspace server's Gmail MCP |
| Email delivery | Gmail MCP `send_draft` adapter described below; creating a draft alone is not delivery |
| Browser on a server | Normal `chrome_devtools_*` tools through codemode, using the server's Chrome |
| Web research | Normal `web_search` and `web_fetch` tools |
| ChatGPT-specific profile, cloud computer, memory and history | Not migrated. Home uses Pi's native context, tools and session history |

Home is a normal Desk worker, not a side model call. Watches, approvals, native
queueing, model credentials, MCP, agent messaging, compaction and host-update
reattachment use the normal worker lifecycle.

## Gmail sending

The existing Gmail adapter already has `gmail.compose` and `gmail.modify` scopes.
Google's [drafts.send endpoint](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.drafts/send)
accepts either scope. No additional OAuth grant is required for sending an existing
draft.

`manage/gmail-send.mjs` adds only `send_draft`. In the existing Gmail MCP adapter,
before connecting its stdio transport, import and register it:

```js
import { registerGmailSendDraft } from "/path/to/pi-plugins/pi-desk/manage/gmail-send.mjs";
registerGmailSendDraft(server, gmailRequest, z);
```

It reuses the adapter's request and credential handling. It adds no token handling
or refresh script. Sending checks the authenticated account, explicitly writes the required From header into the existing draft, and has no automatic retry: an uncertain result requires
checking Sent and whether the draft still exists. The tool reports success only
when Gmail returns a sent-message ID.

Perth has a headless Chrome service (`pi-chrome`, DevTools on loopback port 9222)
and Gmail MCP configured in `~/.pi/agent/mcp.json`. The send registration above is
an additional adapter setup step after merge. A new Home conversation picks up
the configured tools normally; an already running one needs a restart after MCP
configuration changes. Credentials and private job instructions do not belong in
the repository.

## Durable scheduled jobs

The private handover is archived on Perth at
`~/.pi/agent/home/handover/steve-inventory.md`. Seven inert job directories are
staged under `~/.pi/agent/home/staged/jobs/`; no watches or deliveries are started
by staging. Each has verbatim `instructions.md`, `schedule.ics`, a seeded
`baseline.md`, and mutable `state.json`. The full continuity archive is retained.
Personal viewing, email and job-search history is not published in this repository.

All schedules use **Australia/Perth**:

| Job | Schedule | Delivery |
| --- | --- | --- |
| TV alerts | Daily 09:00 | Home + phone, only worthwhile new releases |
| AI job shortlist | Daily 09:00 | Home + phone, only new qualifying roles |
| YouTube watch guide | Daily 09:08 | Email from/to the address in the private instructions; no chat success notice |
| Promotional email review | 1st of each month, 09:08 | Home + phone; sender approval required before unsubscribing |
| WoW Forever news | Daily 09:00 and 18:00 | Home + phone, only meaningful new information |
| Hacker News and alphaXiv roundup | Daily 09:00 | Home + phone, only worthwhile new material |
| Proactive email triage | Daily 07:00, 09:00, 11:00, 13:00, 15:00, 17:00, 19:00, 21:00 | Selective Home + phone heads-ups; otherwise silent |

After merge, stage into the standard runtime location without overwriting state:

```sh
node pi-desk/manage/home-jobs.ts ~/.pi/agent/home/handover/steve-inventory.md
```

Then tell the real Home conversation to call `home_jobs`, read the job directory's
README and arm each next absolute watch, with the job ID and instructions path in
its description. Setup does not run research or send anything. On each wake Home
re-reads the instruction and baseline files, re-arms the next watch first, and
updates checked/delivered state. Compaction therefore cannot remove job rules or
dedup history. Changed handovers require a deliberate merge; staging never
overwrites live dedup state.

`home_notify` is the scheduled chat-delivery path: it saves the update in Home
and explicitly sends a phone notification. Ordinary finished-turn notifications
are insufficient because recurring watches keep Home active. A zero-recipient
push response is a delivery failure, not a verified job.

YouTube checks same-day Sent guides **and** video IDs before sending. During the
approved comparison day, distinguish Home-prefixed mail from Dot's unprefixed
guide; never send a second Home guide that day. Read-only account limits, excluded
sources, previously handled senders and approval requirements are preserved.
No old one-off work or quest reminders are reconstructed from history.

## Scheduled-job cutover

The Dot backend and connector remain during migration. The separate Dot pane and
its client pipeline are removed; Dot's jobs continue running in ChatGPT and its
connector can still reach Pi agents and quests.

1. Preserve the complete fourteen-message handover: six verbatim automation prompts,
   three continuity supplements, the full TV title baseline and historical dedup
   additions. Jordan separately approved the email-triage cadence below. Missing
   IMDb IDs remain unknown; do not invent them.
2. After merge, install the staged seven jobs into the real Home conversation on
   Perth. For each recurring job, create a watch with an absolute `until`; the
   job must re-arm its next occurrence when woken. Reading a quest repeat is not
   a timed notification or email schedule.
3. Keep **Home settings → Compare scheduled deliveries with Dot** enabled for
   one day. Home prefixes scheduled email subjects and notification titles with
   `Home:`. Duplicates are intentional for this comparison day. No real deliveries
   are made by development or test sessions.
4. Verify each Home job's actual delivery against its Dot counterpart. For email,
   retain the provider's sent-message receipt and confirm the message in Sent;
   a draft or a successful model turn is insufficient. Confirm the next watch
   was armed and that its schedule matches the inventory.
5. Only after every job has succeeded, stop Dot's jobs. Clear the comparison
   setting; no code change or release is needed:
   `POST /api/home/settings {"overlap":false}` on the workspace server.
6. Remove the retained Dot connector and backend in a follow-up PR. This PR does
   not stop Dot's jobs or revoke its connector.

The comparison setting is persisted in Home's store and read on every agent turn,
including watch wakes. Existing Dot installations start with comparison enabled.
It changes delivery labelling, not the job schedule or recipients.
