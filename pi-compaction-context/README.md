# pi-compaction-context

Carries Pi's loaded Markdown context files into compaction requests so the
checkpoint writer sees the same project rules that guide normal turns.

The extension watches the system prompt metadata from normal turns, falls back
to parsing the active prompt, and appends a bounded `<pi_compaction_context>`
block to Pi's compaction summarisation request.

Use `/compaction-context` to inspect status, or `/compaction-context on|off` to
toggle the extension for the current session.
