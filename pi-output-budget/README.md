# Output budgets

This bundle policy reduces text admitted to model history without deleting old
messages or making extra model calls to summarise results. SDK children install
it explicitly; `noExtensions: true` still prevents unrelated extension discovery.

## Tools

- `read` retains native path resolution, cancellation and image processing.
  Its text preview is 32,000 characters. `offset` and `limit` select source lines.
  When truncated, the complete **requested range** is captured once in an
  immutable artifact. `full: true` permits up to 128,000 characters in one result.
  Images (PNG, JPEG, GIF, WebP; BMP is converted to PNG) are resized to the
  model's limits and to at most 1.5 MB each, because every request resends every
  image in the conversation. The file on disk is untouched.
- `read_artifact` reads a captured artifact by ID. `offset` and `length` count
  UTF-16 characters, not source lines. Always follow the returned `next_offset`
  until it is `null` when completeness matters. Unicode pairs are not split.
  `query` performs literal, case-sensitive line search over the full artifact;
  paging then refers to the search results.

## Other tool results

Text-only results longer than 16,000 characters are cut to that length, with
the complete text in an artifact.

Pi's own tools cut their output first: `bash` and `powershell` keep the last
50 KB, `grep`, `find` and `ls` the first 50 KB, and `codemode` (its
`max_output_tokens`) and MCP tools (20 KB) the start and end. Their results are
cut again in the same place, so the two cuts act as one, and Pi's closing
notice is kept. When Pi saved the complete output to a temporary file, that
file is captured as an artifact, so it outlives Pi's cleanup; only that path in
Pi's details is followed, never a path inside a tool's or server's payload.

Results of other tools keep their first 16,000 characters. Native details, error
state and nested model usage are preserved. Image blocks pass through untouched.
Limits are characters, not claimed exact token counts.

## Earlier results

Budgets apply only when a result is created: preview caps, artifacts,
`read_artifact`. Earlier results are never rewritten later
in the conversation, because changing earlier context breaks the provider's
prompt cache.

## Storage and privacy

Artifacts live under `~/.pi/agent/tool-output` (or the configured agent directory).
They contain actual file or command output and may contain confidential data.
They are local files, not Wire diagnostic records, and are not uploaded by the
artifact store.
The directory has its own ignore rule. Do not force-add these private artifacts
to Git.

SHA-256 IDs deduplicate identical content and verify integrity before retrieval.
Retrieval caches a small index of byte and character positions, not the full
text. Later pages read only the surrounding byte range. Changes to file identity,
size, modification time, or change time invalidate the index and require another
integrity check. Index storage is bounded to 64 entries and 16 MiB.
Literal search results are captured as separate immutable artifacts so their
later pages also avoid rescanning the original. Both references appear in the
saved tool result. Searches stream through the source and write matching lines
in bounded chunks, including when one line is very large. Concurrent requests
for the same search share the scan. Line numbers, CRLF content and UTF-16 query
semantics are preserved.

Publication is atomic and does not overwrite an existing artifact. Complete
native logs are copied and hashed as files rather than loaded into memory for
archiving. Artifact files survive session compaction and native log cleanup.
There is no automatic artifact expiry. The original source files are never modified.

### Cleanup

From the checkout, preview cleanup with:

```sh
node pi-output-budget/cleanup.mjs
```

It scans main and SDK-child session files, follows references between artifacts,
and preserves reachable output. Captures less than a day old and their references
also remain protected. Temporary capture files are never deleted. The preview
reports counts and sizes, rather than orphan IDs that would become new references
if the preview itself were saved in a session.

After stopping all Pi processes, use `--apply` to remove the eligible files:

```sh
node pi-output-budget/cleanup.mjs --apply
```

`--agent-dir PATH` selects another agent directory. Add every custom session
directory or file with repeated `--sessions PATH` arguments; this also covers
session archives kept outside the default main/child directories.

Source parsing, integrity checks and snapshot checks must all succeed before
deletion starts. Unreadable, malformed, incomplete or changing source files
prevent cleanup. Missing referenced IDs are counted separately: they already
have no file in this store. Scanning uses the available CPU cores and runs only
when this command is invoked.

Pi holds a process-lifetime storage lease, including across extension reloads
and SDK children. Applying cleanup refuses live or unidentified writers, and a
maintenance lock prevents new producers entering during cleanup. PID reuse can
conservatively delay cleanup until that process exits. Stop older Pi versions
too: they predate these ownership records.
