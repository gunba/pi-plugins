# Home

Home is Jordan's page and one persistent Pi conversation on the workspace server
(the computer that keeps conversation copies). Its model is
`openai-codex/gpt-6.1-terra`, with extra-high reasoning, selected from the same model store
as any Desk conversation. Local-only Desk keeps Home on that computer.

## Tasks

Jordan's tasks are a Markdown file the Home conversation keeps,
`~/.pi/agent/home/tasks.md` on the workspace server: tasks with their subtasks as
checkboxes, dates, appointments, routines with their repeat rules, and a Today
section. It is the only task list. Jordan changes it by telling Home; agents add
work for him by messaging Home with `agent_send`. A daily job at 05:00 Perth time
brings the Today section up to date.

## Page and conversation

Home shows the tasks file as Jordan's page, styled like the rest of Desk, with the
live work (questions, approvals, working agents, blocked plans) above it as chips
that open their conversations. The agent keeps the page organised: each `##`
section is a column, side by side on a wide screen and stacked on a phone, in the
order written, with Today first; `###` groups things within a column; text before
the first `##` spans the page; HTML comments hold the agent's own notes and are not
shown. Live work comes from Desk directly, so it never needs an agent turn.

The composer supports files, dictation and a saved delivery receipt, using normal
Desk uploads and input admission. **History** opens the complete native
conversation, including questions, approvals, tool activity and recovery
controls. The last turn's cost is shown in the header.

Home is a normal Desk worker, not a side model call. Watches, approvals, native
queueing, model credentials, MCP, agent messaging, compaction and host-update
reattachment use the normal worker lifecycle.

## Gmail sending

The existing Gmail adapter already has `gmail.compose` and `gmail.modify` scopes.
Google's [drafts.send endpoint](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.drafts/send)
accepts either scope, so sending an existing draft needs no additional OAuth grant.

`manage/gmail-send.mjs` adds only `send_draft`. In the Gmail MCP adapter, before
connecting its stdio transport, import and register it:

```js
import { registerGmailSendDraft } from "/path/to/pi-plugins/pi-desk/manage/gmail-send.mjs";
registerGmailSendDraft(server, gmailRequest, z);
```

Packaged Desk also includes this adapter as `dist/manage/gmail-send.js`. It reuses
the adapter's request and credential handling and adds no token handling or refresh
script. Sending checks the authenticated account, writes the required From header
into the draft, and has no automatic retry: an uncertain result requires checking
Sent and whether the draft still exists. The tool reports success only when Gmail
returns a sent-message ID.

The workspace server has a headless Chrome service (`pi-chrome`, DevTools on
loopback port 9222) and Gmail MCP configured in `~/.pi/agent/mcp.json`. A new Home
conversation picks up configured tools normally; a running one needs a restart
after MCP configuration changes. Credentials and private job instructions do not
belong in the repository.

## Scheduled jobs

Jobs live under `~/.pi/agent/home/jobs/` on the workspace server: an `index.json`
manifest, and per job `instructions.md`, `schedule.ics`, `baseline.md` and a mutable
`state.json`. All schedules use **Australia/Perth**, whatever the server's location
or clock. `home_jobs` lists each job with its next absolute ISO deadline, which Home
passes unchanged to `watch.until`.

| Job | Schedule | Delivery |
| --- | --- | --- |
| Start of the day | Daily 05:00 | Updates the tasks file's Today section |
| TV alerts | Daily 09:00 | Home + phone, only worthwhile new releases |
| AI job shortlist | Daily 09:00 | Home + phone, only new qualifying roles |
| YouTube watch guide | Daily 09:08 | Email from/to the address in the private instructions |
| Promotional email review | 1st of each month, 09:08 | Home + phone; sender approval required before unsubscribing |
| WoW Forever news | Daily 09:00 and 18:00 | Home + phone, only meaningful new information |
| Hacker News and alphaXiv roundup | Daily 09:00 | Home + phone, only worthwhile new material |
| Proactive email triage | Every two hours, 07:00 to 21:00 | Selective Home + phone heads-ups; otherwise silent |

On each wake Home re-reads the job's files, arms its next watch first, then does the
work and records checks and deliveries in `state.json`, so compaction cannot lose
job rules or dedup history. `home_notify` saves an update in Home and sends a phone
notification; a zero-recipient push response is a delivery failure. The YouTube job
checks Sent for a guide already sent that day as well as repeated video IDs.
