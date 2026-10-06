# pi-compaction-context

Carries Pi's loaded Markdown context files into compaction requests so the
checkpoint writer sees the same project rules that guide normal turns.

The extension watches the system prompt metadata from normal turns, falls back
to parsing the active prompt, and appends a bounded `<pi_compaction_context>`
block to Pi's compaction and branch-summary requests. Summary lifecycle events
identify these requests; ordinary model requests are left untouched. Injection
uses provider system-instruction fields (Responses, Chat Completions, Anthropic,
and Google generateContent). It leaves requests unchanged when those fields
already contain the active rules. Unknown payload formats are left unchanged.

This is summary-writer context, not periodic instruction reinjection. Pi 1.0
persists prompt sections and tool declarations independently of the prose summary
and checkpoints them at compaction. Normal turns retain those instructions without
this extension. The extension helps the separate default summary writer, whose
own system prompt does not include project rules. Codex Wire already passes the
full active prompt to its native checkpoint request and does not depend on this
helper for instruction retention.

Use `/compaction-context` to inspect status, or `/compaction-context on|off` to
toggle the extension for the current session.
