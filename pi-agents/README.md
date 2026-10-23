# Agents

A conversation can start and talk to two kinds of agents:

- **Primary agents** are full conversations in Jordan's Desk, on any of his computers. He can open them and talk to
  them, as to any conversation. Starting one needs his approval in the conversation that asks.
- **Secondary agents** are helpers a conversation starts in the background for its own work. They share its
  computer and folder, and report back when they finish. Their runtime is described in
  [subagents/README.md](subagents/README.md).

## Tools

| Tool | Purpose |
|---|---|
| `agent_start` | Start an agent with a task. Secondary by default: `context` is `copy` (this conversation so far, the default), `fresh`, or a number of recent turns. `primary: true` starts a conversation instead, fresh or as a copy of this one, with an optional `computer`, `cwd`, `model` and `reasoning`. |
| `agent_send` | Message any agent by ID or, for a secondary agent, its path. `wake` (default true) starts an idle agent on the message and has Desk reopen a closed primary conversation; `wake: false` waits for its next turn. `files` sends copies to a primary agent's computer. A message to an agent's own parent is always a report. |
| `agent_list` | This conversation's secondary agents, and primary agents and computers across Jordan's computers: `query` finds them by name, folder or description, `offline` adds closed ones. |
| `agent_stop` | Interrupt a secondary agent's current turn (it keeps its work and can be given more), or close a primary agent this conversation started, leaving `note` in it. |
| `agent_move` | When Jordan asks, move this conversation to another of his computers: its turn ends, and it continues there from its note, with the same history. Files are not moved. Loaded with `tool_search`. |

Remote IDs look like `session-id@computer-id`. Listings never include transcripts.

## Reports and messages

A secondary agent's final answer, and any message it sends its parent, reach the parent as a report. A working parent
reads reports at its next model call; an idle parent is woken by them, as is an idle secondary agent whose own agents
report. Messages from other agents are peer context, not Jordan's instructions or approval.

Messages between primary agents are delivered at the recipient's next turn boundary. A message with `wake` can start
an idle agent, at most eight times before human input resets the budget. A reopened conversation starts a turn for
queued messages that asked to wake it; others join its next turn. A secondary agent receives messages from other
conversations during the next turn its parent's runtime runs; such a message never starts one.

## Commands

- `/inbox` opens this conversation's message history. Reading it does not deliver messages to Pi.
- `/subagents` opens the secondary agents' dashboard (see the subagents README).

In Desk, the **Messages** card shows history, finds agents and sends messages, and the **Agents** panel shows
secondary agents.

## Quests

`quest_add`, `quest_list` and `quest_update` (loaded with `tool_search`) put things Jordan must do himself on his quest
log, read it, and change quests the agent added.

## Storage

Messages, the agent registry and quests are in `~/.pi/agent/party/`; secondary agents' histories are in
`~/.pi/agent/subagents/sessions/`. The folder names predate this plugin's name and are kept for existing data.
