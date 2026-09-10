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
details, error state and nested model usage are preserved. Image-bearing results
are unchanged. Limits are characters, not claimed exact token counts.

Completed truncated managed-command logs are archived before native log
cleanup. Earlier truncation is respected even if the final output chunk is
small. Native Bash/PowerShell full-log files are captured when available.
Other tools may already have truncated their data upstream: their artifacts
contain all returned text, including the original truncation/retrieval notice,
not data the underlying tool never returned.

## Storage and privacy

Artifacts live under `~/.pi/agent/tool-output` (or the configured agent directory).
They contain actual file or command output and may contain confidential data.
They are local files, not Wire diagnostic records, and are not uploaded by the
artifact store.
The directory has its own ignore rule, and managed `pi-sync` rules exclude it
from configuration sync. Do not force-add these private artifacts to Git.

SHA-256 IDs deduplicate identical content and verify integrity before retrieval.
Publication is atomic and does not overwrite an existing artifact. Complete
native logs are copied and hashed as files rather than loaded into memory for
archiving. Artifact files survive session compaction and native log cleanup.
There is no automatic expiry: deleting the files manually invalidates their
retrieval handles. The original source files are never modified.
