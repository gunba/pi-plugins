# pi-session-memory

Bounds the memory retained by long-running Pi sessions after compaction.

Pi's session manager keeps every parsed JSONL entry resident so `/tree`, export,
and exact replay can reach pre-compaction history. The model receives only the
compaction-aware working context, but old messages, tool results, images, and
summaries otherwise remain in the Node.js heap.

This extension prunes obsolete payload fields:

- after every successful compaction;
- when an already-compacted session starts; and
- on demand with `/session-memory prune`.

The current model context remains byte-for-byte unchanged. Current-branch custom
entries remain available so extension state, including goals and todos, can
continue. Message metadata, usage accounting, ids, parent links, labels, and
session information also remain resident.

Compacted subagent notifications retain only their `details.messageId` delivery
marker, not their content. Reload recovery needs this marker to distinguish
delivered notices from genuinely pending reports.

After upgrading from a version that removed these markers, restart affected Pi
processes once and resume the saved session. `/reload` alone cannot reconstruct
fields already removed from the resident objects; the complete JSONL archive can.

Pruning changes memory only. The append-only JSONL session file remains complete
and new entries continue appending to it normally.

## Commands

- `/session-memory` or `/session-memory status` — show status.
- `/session-memory prune` — prune now if the session has compacted.
- `/session-memory on|off` — toggle pruning for the current runtime.

Pruning is enabled by default. Set `PI_RESIDENT_SESSION_PRUNE=0` before starting
Pi to disable it.

## Trade-off

In the running process, `/tree` and exports cannot show payloads that an earlier
compaction made obsolete. The complete payloads remain in the JSONL archive.

## Delivery-recovery verification

9 September 2026: TypeScript and all 93 memory/subagent tests passed. The
regression covers compaction, repeated pruning, session reopening, pending
reports and unchanged JSONL bytes. A read-only replay of an affected session
reproduced 166 false recoveries with the former cleanup and zero with the fix.
No inference probes or session-file edits were used.
