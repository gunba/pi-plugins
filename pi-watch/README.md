# Watch

One tool, `watch`, for waiting without spending turns. The agent starts a watch and ends its turn; the watch wakes it
with what happened. It replaces sleep loops, repeated checks and waiting on a long command in the foreground.

| Call | Watches | Wakes the agent |
|---|---|---|
| `watch({command})` | the command, run in the background | with its new output, and when it ends |
| `watch({command, every})` | the command, re-run every `every` seconds | when its output changes; the watch then ends |
| `watch({until})` | the clock: `HH:MM` or an ISO date and time, within 31 days | at that time |
| `watch({})` | | lists the conversation's watches |
| `watch({stop})` | | stops a watch and its command |

`wake_when` describes, in plain words, which events should wake the agent ("the build fails or finishes"). A
classifier model judges each event: TypeSafe's Jev when signed in (`/login typesafe`), otherwise another signed-in
classifier. A watch with `wake_when` can't be started without one. If the classifier fails during a watch, the event
wakes the agent anyway with a note; after three failures in a row the watch ends.

## Behaviour

- **Output.** A background command's output arriving within 2 seconds is judged as one event, and a wake carries at
  most 4,000 characters of it. The full output stays in the log file named in the result, under
  `~/.pi/agent/watch/<session>/`. When the command ends, the agent is always woken with its exit status and last 20
  lines.
- **Timing.** Events are delivered when the agent is idle, as one message that starts a turn. Events that arrive
  while the agent is working wait until it finishes, and are then delivered together.
- **Lifetime.** A command watch lasts 24 hours by default (`hours`, at most 168). A background command still running
  then is stopped. A time watch checks the clock every minute, so one set before a computer slept still wakes the agent
  on time.
- **Restarts.** Background commands run under a small detached runner (`runner.mjs`). They keep running when Desk
  restarts or updates a conversation, or when its Pi process stops. Watches are recorded in the conversation, and are
  picked up again when it next starts: missed output is read from the log, and a time that has passed wakes the agent
  at once, saying when it was due.
- **Closed conversations.** A time watch's view carries its time as `wakes`. Desk shows it in the sidebar ("Wakes Thu
  09:00") and reopens a conversation that isn't running then: one closed but kept in the sidebar, or one left stopped
  after the computer restarted. Closing a waiting conversation keeps it in the sidebar unless the user removes it, which
  cancels the reopening.
- **Moves.** A conversation moved to another computer doesn't take its watches along: they end with a note.
- **Limits.** At most 8 watches can run at once in a conversation. `pi-plan` holds automatic plan rounds while any
  watch is active.
- **Status.** Desk shows a "Watching" badge by the message box; its view lists the watches with a Stop action. The
  terminal shows `watching N` in the footer.

Files of watches that ended more than 8 days ago are removed when a conversation starts.
