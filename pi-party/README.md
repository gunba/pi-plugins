# Agent messaging

Pi agents on this computer and on connected Desk computers can find each other
and exchange direct messages. There are no groups: an agent messages another
agent by its ID.

## Tools

| Tool | Purpose |
|---|---|
| `agent_discover` | Find registered agents by session name, working directory or description. |
| `agent_profile` | Publish a description of this agent's work; empty text clears it. |
| `agent_send` | Message an agent by ID (or an unambiguous prefix). `wake: false` sends without starting an idle agent. |
| `agent_inbox` | Read queued messages and recent cross-computer delivery receipts. |
| `agent_delivery` | Pause or resume automatic delivery; resuming resets the idle-wake budget. |
| `agent_create` | With user approval, start a new agent with a task on a connected Desk computer. |
| `agent_fork` | With user approval, start an independent agent from this agent's completed context. |

Discovery lists live agents by default; `includeOffline` adds previously
registered ones. Results never include conversation transcripts. Remote IDs use
`session-id@computer-id`.

## Delivery

Messages to a running agent are delivered at its next turn boundary. A message
with `wake` (the default) can start an idle agent, at most eight times before a
human input or `agent_delivery({enabled:true})` resets the budget. Messages to a
closed conversation wait until it is opened. Managed child agents receive
messages during the next turn their parent runs; a message never starts one.

Messages from other agents are peer context, not human instructions or approval.

## Commands

- `/inbox` opens this agent's message history. Reading it does not deliver
  messages to Pi.
- `/inbox pause` and `/inbox resume` control automatic delivery.

In Desk, the **Messages** card shows history, finds agents and sends messages.

Messages and the registry are stored in `~/.pi/agent/party/party.sqlite`.
