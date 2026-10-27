# Conversation search

Two native tools search retained Pi histories through Desk:

- `conversation_search` finds passages using full-text search and local embeddings.
- `conversation_read` expands a returned reference along its conversation branch.

They are deferred tools in the `memory` namespace, available through `tool_search`,
including to secondary agents that inherit them. They do not start another agent,
add history automatically to prompts, or require a new API key.

```js
const result = await tools.conversation_search({
  query: "why the new control was missing after updating",
  project: "pi-plugins",
  before: "2026-10-01",
  limit: 8,
  max_chars: 8000,
  description: "Find the earlier diagnosis of the missing control."
});
```

Use `conversation_read` with a result's `reference` and the returned `server`.
References identify native evidence, not arbitrary file paths. Results include
computer, native session and entry IDs, speaker, time when known, project, and
position in the redacted entry. Retained identical copies can preserve a reference
when a file or conversation moves. A removed reference fails rather than opening
an unrelated file.

Omit `query` for status. `server` selects a computer by its exact announced name or
ID. By default, a single available computer that keeps copies hosts the search;
multiple hosts require an explicit choice. `server: "local"` explicitly uses this
computer, with only its local histories when it is not a search host. Status can
also be requested from a named source computer that supports synchronization.

`project` and `agent` filter folder and conversation-title substrings. `session`
selects a native session ID. Date-only bounds are UTC; timestamps require an
explicit time zone. `after` is inclusive, `before` exclusive. `include_tools`
defaults to true. Search returns at most 30 passages; search/read responses default
to 12,000 characters and accept a 2,000–24,000-character budget. Status has bounded
diagnostics rather than a passage budget.

## Hosting and sharing

Sign the computers into the same owner-controlled Desk workspace. In
**Settings → Accounts & connections**, under the selected computer:

- **Send this computer's conversations** publishes its retained searchable text.
- **Keep copies and host conversation search** makes that computer a search host.
  This is normally the workspace server.

Text travels over Desk's existing authenticated, encrypted computer channel. The
routing relay does not index it. The chosen search host is trusted with decrypted
history, just as a computer keeping recovery copies is trusted with those copies.
Its search database lives under `<Desk data directory>/search/index.sqlite`.

Source capture and inference run in a dedicated worker, not the host UI loop.
Capture starts with the authenticated workspace connection, or an explicit local
search. Native files are checked periodically; indexing is not a synchronous view
of every running agent. Older hosts without this capability and computers that
have not synchronized are reported as coverage gaps. Existing recovery copies
are not silently promoted into an independent permanent search archive.

The native tools contact only this profile's recorded loopback host and keep its
operator credential out of tool arguments and output. Desk workers receive their
host-data location automatically. Standalone Pi uses its profile's installation;
for an unmanaged custom data directory, set `PI_DESK_DATA_DIR` explicitly. Missing
profiles do not cause a search for another profile's credentials. No host is
started or updated by a search request.

## What is indexed

Capture covers native files in the profile's `sessions` and `subagents/sessions`
roots, the configured session directory, and managed files outside those roots.
Previously discovered external files remain tracked after their conversations
close. Arbitrary backups or unknown custom directories are not scanned.

Included:

- user and assistant text;
- native compaction/branch summaries and recognized agent reports/follow-ups;
- tool-result text in a separate keyword lane.

Excluded:

- hidden reasoning and image/binary blocks;
- tool-call arguments and unknown UI-only custom messages;
- direct search/read results, and nested tool results carrying their origin marker;
- explicitly excluded native sessions and their secondary histories.

Common credential-shaped values are redacted before storage and transfer. This is
not a general personal-information sanitizer or a boundary for an untrusted server.
New assistant reports remain native history, even if they discuss earlier evidence.
Speaker labels are native roles: a `user` record can also contain automation or a
delegated task. Historical content is not current permission or a new instruction.

A record larger than 64 MiB is skipped with an index warning. Complete records are
checkpointed; unfinished trailing JSONL records are retried. Appends verify the
entire previously indexed prefix, so an in-place rewrite followed by an append
cannot silently preserve obsolete text. An unavailable directory or changed volume
identity suspends deletion rather than treating missing access as an empty archive.

## Retention

Search is a derived index, not a second retention authority:

- A successful source inventory removes deleted or excluded files from the host's
  index. Unreferenced text, FTS entries and vectors are removed together; database
  free space is reclaimed incrementally.
- Source-declared expiries remain enforceable when a computer is offline.
- Disconnecting or failing to enumerate a directory does not delete its last-known
  history. Deletions made while offline take effect when synchronization resumes.
- Turning source sharing off withdraws its published index on connected search
  hosts. It does not delete the original native files.
- A move or fork does not erase text that still has another retained native source.
  Late transfers/inference cannot revive deleted evidence or overwrite a new text
  row that reused an old database ID.

The native SDK does not provide a disk-history TTL here: closing, compacting, or
pruning resident context does not delete the JSONL history. Those files remain
searchable until the source actually removes or excludes them. Search does **not**
inherit recovery copies' separate 30-day inactivity window or invent a new TTL.
It does not provide cryptographic erasure of OS backups or a global "forget this
fact" operation across other retained conversations quoting the same information.

On each source computer, optional local settings are stored at
`<Desk data directory>/search/settings.json`:

```json
{
  "semantic": true,
  "exclude": ["native-session-id", "native-root-session-id"]
}
```

`exclude` applies to that computer's original histories; a root ID also excludes
its secondary histories. `semantic: false` disables this host's embeddings while
retaining keyword search. Original files are never changed by these settings.

## Retrieval and resources

SQLite FTS5 supplies keyword candidates; natural text also has normalized,
768-dimensional embeddings. Tool results are not bulk-embedded. Exact cosine
search and weighted reciprocal-rank fusion combine the lanes, with session
variation to keep one long transcript from occupying every result. Project,
session, date, workspace and speaker restrictions apply before candidate limits.
Reads follow searchable ancestry and stop at ambiguous branch splits.

The model is
[`paraphrase-multilingual-mpnet-base-v2`](https://huggingface.co/sentence-transformers/paraphrase-multilingual-mpnet-base-v2/blob/4328cf26390c98c5e3c738b4460a05b95f4911f5/README.md),
by Sentence Transformers, under Apache-2.0. The pinned quantized ONNX model and
its tokenizer total about 288 MB. Downloads are size/digest checked; there is no
unversioned model selection. This implementation uses masked mean pooling,
normalization, and a 256-token input cap. Stored passages are at most 1,000
characters; unusually token-dense passages can be truncated for embeddings while
their full stored text remains keyword-searchable and readable.

ONNX Runtime uses CPU only. On multicore machines it reserves at least a quarter of logical CPUs and
caps inference at 16 threads; background batches shrink after recent queries.
Measured on a 24-logical-core Linux desktop, long-passage throughput increased
from about 7 to 14 passages/second when using the verified larger configuration.
The embedding process used roughly 0.7–0.9 GiB RSS in that synthetic measurement;
actual index size, machine performance, and capture load change the footprint.
The in-memory vector cache is bounded. Initial backfill can take time on a small
server, but keyword search remains available and status reports the backlog.

Indexing and retrieval use no paid inference API and send no history to an
embedding vendor. The server pays ordinary storage/CPU costs. Returned passages
enter the calling agent's context and its configured model provider, with the
normal usage costs. `mode` distinguishes `hybrid`, `keyword`, `context` and
`status`; partial coverage must not be interpreted as "this never happened."

The design follows the useful retrieval pattern in
[Turnbook, formerly graph-mind](https://github.com/goyohan0611-png/turnbook): local
embeddings plus keyword retrieval and bounded source expansion. It does not
introduce a graph database, a separate search daemon, or a generative model call
to summarize each document.

For development, use the repository's `npm --prefix pi-desk ci --ignore-scripts`
installation path and rebuild the required keyring dependency as usual. CPU ONNX
binaries are bundled in the pinned package. If manually running its install script
on Linux/x64, set `ONNXRUNTIME_NODE_INSTALL=skip` to avoid unnecessary CUDA downloads.
