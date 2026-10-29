# Agents

Lets a conversation start and talk to other agents.

- **Primary agents** are full conversations in Desk, on any of the user's computers. The user can open them like any
  conversation. Starting one needs the user's approval.
- **Secondary agents** are helpers a conversation starts in the background for its own work. They share its computer
  and folder, and report back when they finish ([`subagents/README.md`](subagents/README.md)).

## Tools

| Tool | Purpose |
|---|---|
| `agent_start` | Start an agent with a task. Secondary by default, with `context` `copy` (the conversation so far), `fresh`, or a number of recent turns. `wake: "all"` holds an idle parent's wake until the last such agent finishes. `primary: true` starts a conversation instead, with an optional `computer`, `cwd`, `model` and `reasoning`. |
| `agent_send` | Message an agent by ID, or a secondary agent by path. `wake` (default) starts an idle agent on the message, and reopens a closed primary one; `files` sends copies to a primary agent's computer. |
| `agent_list` | This conversation's secondary agents, and primary agents and computers: `query` finds them by name, folder or description, `offline` adds closed ones. |
| `agent_stop` | Interrupt a secondary agent's turn (it keeps its work), or close a primary agent this conversation started. |
| `agent_move` | Move this conversation to another computer when the user asks: it continues there from its note, with its history. Loaded with `tool_search`. |

Remote IDs look like `session-id@computer-id`. Listings never include transcripts.

## Messages

A secondary agent's final answer, and anything it sends its parent, reaches the parent as a report: at the parent's
next model call if it is working, or as a new turn if it is idle. Messages between primary agents arrive at the
recipient's next turn boundary; a message with `wake` can start an idle agent, at most eight times before the user
writes again. Messages from other agents are context, not the user's instructions or approval.

`/inbox` shows a conversation's messages; `/subagents` shows its secondary agents. In Desk, the Messages card and the
Agents panel show the same.

## Quests

`quest_add`, `quest_list` and `quest_update` (loaded with `tool_search`) keep the user's list of things only they can
do: add, read, and change the quests the agent added. The list is kept by the computer that keeps conversation copies,
and agents on other computers reach it through their Desk (`quest-log.ts`).

## Storage

Messages, the agent registry and quests are in `~/.pi/agent/party/`; secondary agents' histories are in
`~/.pi/agent/subagents/sessions/`.
