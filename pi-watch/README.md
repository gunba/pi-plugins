# Watch

One tool, `watch`, for waiting without spending turns. The agent starts a watch and ends its turn; the watch wakes it
with what happened. It replaces sleep loops, repeated checks and waiting on a long command in the foreground.

| Call | Watches | Wakes the agent |
|---|---|---|
| `watch({command})` | the command, run in the background | with its new output, and when it ends |
| `watch({command, every})` | the command, re-run every `every` seconds | when its output changes; the watch then ends |
| `watch({until})` | the clock: `HH:MM` or an ISO date and time | at that time |
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
- **Lifetime.** There is no time limit. A command watch runs until its command ends, it wakes the agent (a re-run
  command), or the agent or the user stops it; `hours` gives it an end if the agent wants one, and a background command
  still running then is stopped. A time can be any time ahead. Times are checked against the clock every minute, so a
  computer that slept still acts on time.
- **Restarts.** Background commands run under a small detached runner (`runner.mjs`). They keep running when Desk
  restarts or updates a conversation, or when its Pi process stops. Watches are recorded in the conversation, and are
  picked up again when it next starts: missed output is read from the log, and a time that has passed wakes the agent
  at once, saying when it was due.
- **In Desk.** A time watch's view carries its time as `wakes`: the sidebar shows it ("Wakes Thu 09:00"), and Desk
  reopens a conversation that isn't running then, whether it was closed and kept in the sidebar or left stopped when
  the computer restarted. Closing a waiting conversation keeps it in the sidebar unless the user removes it, which
  cancels the reopening. A command watch marks the view as `watching`: the sidebar shows "Watching", and Desk starts
  the conversation again if its process was lost (the computer restarted, say). Closing it deliberately pauses its
  watches ("Watch paused") until it is opened again. The composer shows an eye with the number of watches, which opens
  their list.
- **Labels and wakes.** A watch takes its label from the description the agent gives its call (pi-ui's description
  field), so the user sees what it is for. Each wake carries `details.events` (`WatchEvent`: the label, what happened,
  the output, the command and the log) beside the agent's text; Desk titles the notice with the label and what
  happened, and shows the output under it.
- **Moves.** A conversation moved to another computer doesn't take its watches along: they end with a note.
- **Limits.** At most 8 watches can run at once in a conversation. `pi-plan` holds automatic plan rounds while any
  watch is active.
- **Status.** Desk shows a "Watching" badge by the message box; its view lists the watches with a Stop action. The
  terminal shows `watching N` in the footer.

Files of watches that ended more than 8 days ago are removed when a conversation starts.
