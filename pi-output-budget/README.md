# Output budgets

This bundle policy reduces text admitted to model history without deleting old
messages or making extra model calls to summarise results. SDK children install
it explicitly; `noExtensions: true` still prevents unrelated extension discovery.

## Tools

- `read` retains native path resolution, cancellation and image processing.
  Its text preview is 32,000 characters. `offset` and `limit` select source lines.
  When truncated, the complete **requested range** is captured once in an
  immutable artifact. `full: true` permits up to 128,000 characters in one result.
- `read_artifact` reads a captured artifact by ID. `offset` and `length` count
  UTF-16 characters, not source lines. Always follow the returned `next_offset`
  until it is `null` when completeness matters. Unicode pairs are not split.
  `query` performs literal, case-sensitive line search over the full artifact;
  paging then refers to the search results.
- `inspect_files` batches up to 20 explicit file reads or literal searches.
  Results remain in request order; one file error does not hide other results.
  Each file retains its own large-output reference, and the combined preview is
  also bounded. Images use `read`.

Other text-only tool results receive a 16,000-character preview. Their native
details, error state and nested model usage are preserved. Image blocks pass
through untouched. Limits are characters, not claimed exact token counts.

Completed truncated managed-command logs are archived before native log
cleanup. Earlier truncation is respected even if the final output chunk is
small. Native Bash/PowerShell full-log files are captured when available.
The MCP adapter's full-text spill files are also captured, even when the returned
preview is short or accompanied by images. Their artifact references point to
the complete original text, including in later compacted observations. Paths
inside server-controlled MCP payloads are not followed.
Other tools may already have truncated their data upstream: their artifacts
contain all returned text, including the original truncation/retrieval notice,
not data the underlying tool never returned.

## Older observations

At the start of a later turn, a successful text-only tool result followed by at
least two assistant responses and backed by an existing output artifact becomes
a short `read_artifact` link in provider context. The selection stays fixed
through that turn so tool-call continuations retain a stable history. The
session history and original artifact are unchanged.
Recent results, errors, images, and results without an available artifact retain
their original content. This avoids replaying the same large preview throughout
a long session without creating another archive or recall tool. The idea is
adapted from [SoL-Pi's ObservationPack](https://github.com/NVlabs/SoL-Pi)
(MIT), using this bundle's existing artifact store.

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
saved tool result.

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
