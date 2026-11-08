# pi-handbook

Each conversation keeps a handbook: its purpose, the user's lasting instructions in their own words, and what the
conversation has learned about doing its kind of work. The handbook goes to the model as a prompt section, so it
survives compaction word for word, while compaction itself is unchanged. It is not global memory: each conversation
has its own, and it holds nothing about the user beyond how they want this work done.

## What the model sees

A `<conversation_handbook>` section of the system prompt, at most 12,000 characters:

- **Purpose**: one or two sentences on what the conversation is for and what it is not for.
- **Instructions**: each quotes the user's message, with its date. A newer message from the user overrides them.
- **Learnings**: what the conversation found out, such as where things are, a procedure that worked, an option
  rejected and why. The model is told to check a learning against the current state before relying on it.

An entry can say what it **holds while** (the conditions it rests on: an assumption, a version, when to reconsider)
and what it **points to** (files or addresses).

A changed section reaches the model without costing the prompt cache. It goes in after a compaction, once the cache
has expired, or, on models that take system messages mid-conversation, as an appended patch: at the next turn after
the user's own edits, and at most every four hours for the agent's and the tidy-up's. A restarted conversation keeps
the section the model last had until then.

## Who writes it

- **The agent**, with the `handbook` tool. An instruction must quote the user's message exactly, or the tool refuses
  it; it counts at once. A learning waits for the tidy-up. The agent can flag an entry that turned out wrong, write
  the purpose when there is none, and read the whole handbook.
- **The tidy-up**, a side request on the conversation's model. It runs when the conversation has been idle for ten
  minutes, about once a day, and reads the user's messages since its last run, each with the end of the agent's
  reply before it. It catches instructions the agent missed, admits or turns down the agent's learnings, merges
  and replaces entries, and labels each message (instruction, correction, repeat or other) for the chart. A backlog
  takes several passes in a row. A pass adds at most one new entry for every ten messages it reads, and never more
  than six, the most important first; replacing and merging entries don't count.
- **The user**, in Desk's Handbook view: add an instruction, edit, pin or remove an entry, accept or dismiss a
  flag, edit the purpose.

The tidy-up returns changes to single entries as JSON, and code applies them after checking each:

- only the user's messages can create instructions: a quote must be in the message it names, in whole words;
- pinned entries and prohibitions ("never", "do not") are never changed or removed by the tidy-up, only flagged
  for the user;
- an instruction leaves the handbook only when the user's newer words replace it, or when the user accepts the
  tidy-up's flag; a learning is retired with a reason when the work it concerned is finished;
- a replaced or retired entry stays in the change log with the reason;
- the tidy-up can write the purpose only when there is none; after that it proposes, and the user decides;
- a learning that has not come up in 30 days of use is retired (days on which the user wrote in the
  conversation, so a quiet month changes nothing).

Each pass records, per entry, whether the work touched it, whether the agent followed it and was corrected, and
whether the user had to say it again.

## Other agents' handbooks

An agent can read another conversation's handbook with the tool's read action and `agent` (a name or ID from
`agent_list`), on any of the user's computers: one on this computer is read from its history, one elsewhere is
asked of that computer's Desk (the `handbook` agent operation). Reading changes nothing.

## History

A new conversation's handbook reads from its first message. In a conversation that existed before this extension,
reading starts where it arrived; **Read earlier messages** in the view reads the rest, after showing the number of
messages and an estimate at API prices.

## Storage

Changes are `pi-handbook/change-v1` custom entries on the branch (`src/domain.ts` folds them), so the handbook
moves with the conversation to another computer, and a branch keeps the handbook it had. The section text the model
last had is a `pi-handbook/published-v1` entry. Helpers and other managed children have no handbook.

## Desk

The footer's book badge shows the number of entries and opens the view: the purpose, the entries with their
quotes, conditions, pointers and use, those waiting for review, a chart of the user's messages per day (corrections
and repeats marked) with the days the handbook changed, and the change log. `/handbook` opens it, or prints the
handbook in a terminal.
