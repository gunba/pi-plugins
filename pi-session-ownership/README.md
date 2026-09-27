# Session ownership

Keeps an OS-backed exclusive lease for each persistent Pi session. Desk obtains
the lease before opening a file. The terminal integration holds it through
reloads and releases it after shutdown handlers finish.

An SQLite transaction supplies the lock; the database contains no transcript.
Lock files live in `.pi-ownership/` beside the session files. Do not delete them
while Pi is running. A process crash releases its OS lock immediately. Sleeping
processes keep their locks rather than losing a heartbeat race.

The integration rejects a second owner at session start and cancels terminal
switches when the destination is occupied. In-memory sessions need no lease.
Hard-linked session files are rejected; symlinks use their canonical target.
Use a local filesystem with working SQLite locks.

## Cutover

Restart existing terminals after installing this extension. Processes started
without the integration do not participate; no extension can lock out an
unmodified writer.

Pi currently loads existing files before emitting `session_start`. An older
file can therefore be migrated or have missing metadata repaired before the
terminal extension is called. Desk locks before those operations, but the
unmodified CLI does not offer that pre-open hook. Do not start a terminal on a
Desk-owned file. Concurrent legacy-file migration is not covered by this
extension; a supported pre-open integration is still needed for that boundary.
