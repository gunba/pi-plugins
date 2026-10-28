# Compaction context

Writes compaction summaries and briefs from the conversation's prompt cache when it can.

- **Summary in place.** When a conversation compacts while its cache is warm, the request it last sent is replayed
  byte for byte with one message asking for Pi's summary, in Pi's format and up to Pi's cut point. The provider reads
  the conversation from its cache instead of charging for it again. Otherwise (the cache has expired, the context
  overflowed, or the model changed) Pi writes the summary itself, unchanged. Codex conversations use Codex Wire's own
  compaction instead.
- **Briefs.** Desk's "What do I need to know?" brief on the latest turn is written the same way, from the cached
  request. A brief on an earlier turn, or once the cache has expired, is written from a copy of the conversation up to
  that turn's reply, sent in full. While the user is away, one is written after a turn that edited files or made many
  tool calls, from the cached request only.

`/compaction-context` shows whether the last summary was written in place, and if not, why.
