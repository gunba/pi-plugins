# pi-session-memory

Frees the memory a long conversation holds for history that compaction has already summarised.

Pi keeps every entry of a session in memory, so its tree view, export and replay can reach history from before a
compaction. The model only ever sees the summary and what came after it, but old messages, tool results, images and
summaries stay in the process. In a long conversation that is hundreds of megabytes.

After every compaction, when a compacted session starts, after tree navigation, and on `/session-memory prune`, this
extension empties those old payloads in memory. It keeps each entry's IDs, links, role, usage and timestamps, the
current branch's extension state, and the delivery markers of agent reports. What the model receives is unchanged,
and the session file on disk stays complete; new entries append to it as usual.

The released history is read back from the session file when it is needed:

- **Desk** shows old messages by reading them from the file (`archive.ts`: each line's position is indexed once, and
  a message is one read), so scrolling back shows full history without holding it in memory.
- **Tree navigation and forks** restore the released payloads in place first, after checking the session ID, entry
  IDs, links and roles against the file. Navigation is cancelled if the file cannot supply them.

## Commands

- `/session-memory` or `/session-memory status`: what has been released.
- `/session-memory prune`: release now, if the session has compacted.
- `/session-memory on|off`: turn releasing on or off for this process; `off` restores what was released.

Set `PI_RESIDENT_SESSION_PRUNE=0` before starting Pi to turn it off.
