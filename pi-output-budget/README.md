# Output budgets

A tool result over Pi's output limits (2,000 lines or 50 KB) reaches the model as a short excerpt: one line giving
its length and the file holding all of it, then its last 40 lines for `bash` and PowerShell (a command's end holds
its result and errors) or its first 40 for other tools, within 3,000 bytes. The model reads or greps the file for
anything else. Sending 50 KB of a long output cost about 12,000 tokens, kept in every later request.

- **Pi's tools** cut their own output and save the whole of it to a temporary file; a copy is kept in the output
  store, the excerpt is made from it, and Desk shows the complete output after Pi deletes the file. Images in a
  result are kept.
- **Other tools' text results** are saved whole under `~/.pi/agent/tool-output/` and excerpted the same way.
- **Calls a codemode program makes** return whole to the program (Pi's tools still stop at their own 2,000 lines or
  50 KB, with the full output's path), so it can pick out what it needs; only the program's own result is excerpted.
- **`read`** pages through a file as Pi's read does: 2,000 lines or 50 KB at a time, then an offset to continue.
- **Images** from `read` are shrunk to at most 1.5 MB each, within Pi's own limit of 2,000 pixels a side, because every
  request resends every image in the conversation. The file on disk is untouched.
- **Missing paths** in a failed `read`, `grep`, `ls`, `find`, `edit` or `write` get a hint naming files with that name
  in the folders the conversation works in.
- **Failed edits** get the closest region of the file, with line numbers, or the line of each occurrence when the
  text is not unique.
- **A shell killed by its own `pkill -f`** (exit 143; the pattern matches the command's own shell) gets a hint to
  kill by process ID instead.

Limits apply when a result is created. Earlier results are rewritten only where a request cannot be sent otherwise,
because changing earlier context breaks the provider's prompt cache: from that point on, the conversation is sent
again at full price.

- **Claude requests over 120 MB**, near Anthropic's 128 MB limit, have the oldest images replaced with a note in the
  saved conversation until 60 MB of images remain. A request over 80 MB is trimmed the same way when it
  pays for its whole prompt anyway: its cache has expired, or it follows compaction or a model or thinking change. A
  trimmed request is sent exactly as Pi sends the edited conversation afterwards, so the next request reads it from
  the cache.

## Storage

Saved outputs live under `~/.pi/agent/tool-output` as `sha256-<hash>.txt`, private to the user. Identical outputs are
stored once. They are never uploaded and do not expire on their own.

To remove outputs no saved conversation refers to, stop all Pi processes and run:

```sh
node pi-output-budget/cleanup.mjs           # preview
node pi-output-budget/cleanup.mjs --apply   # delete
```

`--agent-dir PATH` selects another agent directory, and `--sessions PATH` (repeatable) adds session folders kept
elsewhere. Outputs less than a day old are kept, and cleanup refuses to run while a Pi process holds the store.
