# Compaction context

Writes summaries from the conversation's own prompt cache, and gives Pi's summariser the project's rules.

- **Summary in place.** When a conversation compacts, the request it last sent is replayed byte for byte with one
  message asking for the summary, so the provider reads the whole conversation from its prompt cache instead of
  charging for it again. The summary uses Pi's format. Codex conversations use Codex Wire's own compaction instead.
- **Rules for Pi's summariser.** When the in-place summary cannot be used (the cache has expired, or the model gave no
  summary), Pi's own summary request runs, with a system prompt that does not include the project's `AGENTS.md` or
  `CLAUDE.md`. This adds them, so the summary keeps the project's rules in view. Only summary and branch-summary
  requests are changed; ordinary turns are not touched, so their prompt cache is unaffected.
- **Briefs.** Desk's "What do I need to know?" brief is written the same way, from the cached request. While the user
  is away, one is written after a turn that edited files or made many tool calls.

`/compaction-context` shows whether the last summary was written in place, and `/compaction-context on|off` turns the
rules for Pi's summariser on or off for the current session.
