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

## Resume in Desk

An explicit Resume in Desk can take over a conversation from desktop Pi.
The desktop extension stops the current operation and requests Pi's native
orderly shutdown. Desk waits for the exclusive lease before reading the session,
so shutdown hooks can finish saving history. Unrelated sessions are not stopped.
Automatic host recovery never requests a takeover.

Each participating terminal publishes a loopback-only control endpoint and a
private random capability in `~/.pi/agent/session-handoffs`, inside the user's
profile even when the session directory is shared. The endpoint checks that it still owns
that exact session. It cannot run commands or select a different process to stop.
Desk workers do not publish this endpoint. Requests do not use HTTP proxies, and
browser-origin requests are rejected.

If shutdown does not release the lock within a minute, Desk reports the delay
without opening the file. It never deletes a live lock or force-kills a PID.
Terminals must load the updated extension before they can be taken over; otherwise
close them manually once. Endpoint metadata left by a crash does not confer
ownership and is replaced only by the next lease holder.

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
