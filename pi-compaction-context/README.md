# Compaction context

Writes compaction summaries the way Claude Code does, and briefs from the prompt cache.

- **Compaction.** When a conversation that is not on Codex compacts, the model that ran it writes a detailed summary
  of the whole conversation, asked as one more turn of it, and the summary replaces it. The request follows Claude
  Code's: text only, an `<analysis>` block and then a `<summary>` block with nine sections (the user's requests and
  intent, key concepts, files and code, errors and fixes, problem solving, every user message, pending tasks, current
  work, and the next step with the user's own words). `/compact <focus>` adds the focus as additional instructions.
  Only the `<summary>` block is kept.
  - While the conversation's prompt cache is warm, the request it last sent is reused byte for byte, followed by the
    reply and tool results since and the summary request, so the provider reads the conversation from its cache and
    nothing new is cached. Otherwise (the cache expired, the context overflowed, the model changed, or the API is not
    Anthropic's) the conversation is sent again in full with its own system prompt, tools and thinking level. After an
    overflow, the oldest tool results and then the oldest messages are left out until it fits.
  - Pi needs a kept entry, so the last reply and its tool results (or the newest message after it) stay as they were.
    Claude Code keeps nothing; a session too short for Pi to compact cannot be compacted manually either.
  - After the summary come where to find the full history (`conversation_search`), the instruction to carry on without
    recapping, and what Claude Code puts back: the current contents of the five files most recently read, edited or
    written (up to about 5,000 tokens each, otherwise a note to read them again), the skills loaded (`SKILL.md`, up to
    5,000 tokens each and 25,000 in all), the plan unless it is complete, and the watches still running.
  - A failed summary (an error, a reply cut off at the output limit, or no summary) is retried with Pi's retry
    settings when the failure is transient, then cancels the compaction and holds automatic compaction as
    `pi-context-window` does. Pi's own summary is never used. Codex conversations use Codex Wire's own compaction.
- **Briefs.** Desk's "What do I need to know?" brief on the latest turn is written the same way, from the cached
  request. A brief on an earlier turn, or once the cache has expired, is written from a copy of the conversation up to
  that turn's reply, sent in full. While the user is away, one is written after a turn that edited files or made many
  tool calls, from the cached request only.

`/compaction-context` shows how the last summary was written: from the cached request, or from the whole conversation
and why.
