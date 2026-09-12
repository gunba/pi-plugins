# pi-session-memory

Bounds the memory retained by long-running Pi sessions after compaction.

Pi's session manager keeps every parsed JSONL entry resident so `/tree`, export,
and exact replay can reach pre-compaction history. The model receives only the
compaction-aware working context, but old messages, tool results, images, and
summaries otherwise remain in the Node.js heap.

This extension prunes obsolete payload fields:

- after every successful compaction;
- when an already-compacted session starts or tree navigation finishes; and
- on demand with `/session-memory prune`.

The current model context remains byte-for-byte unchanged. Current-branch custom
entries remain available so extension state, including goals and todos, can
continue. Message metadata, usage accounting, ids, parent links, labels, and
session information also remain resident.

Compacted subagent and party notifications retain only their `details.messageId`
or batched `details.messageIds` delivery markers, not their content.
`party_read` tool results retain only `details.partyMessageIds`.
Reload recovery uses these markers to distinguish delivered messages from
genuinely pending reports.

Pruning changes memory only. The append-only JSONL session file remains complete
and new entries continue appending to it normally. In-memory sessions without a
persisted archive are not pruned.

## Commands

- `/session-memory` or `/session-memory status` — show status.
- `/session-memory prune` — prune now if the session has compacted.
- `/session-memory on|off` — toggle pruning for the current runtime.

Pruning is enabled by default. Set `PI_RESIDENT_SESSION_PRUNE=0` before starting
Pi to disable it.

## Restoring history

Before tree navigation or a native fork, released payloads are restored in place
from the session archive. The session ID, entry IDs, parent links and message
roles are checked before any payload is restored. Navigation is cancelled if
the archive cannot supply the matching history. This restores checkpoint details
as well as text, without rewriting JSONL or replacing the session tree.

`/session-memory off` restores released payloads and disables further pruning.
Use it before exporting complete history from a running process. Native
compaction checkpoints in the active context are always retained.

## Delivery-recovery verification

9 September 2026: TypeScript and all 93 memory/subagent tests passed. The
regression covers compaction, repeated pruning, session reopening, pending
reports and unchanged JSONL bytes. A read-only replay of an affected session
reproduced 166 false recoveries with the former cleanup and zero with the fix.
No inference probes or session-file edits were used.
