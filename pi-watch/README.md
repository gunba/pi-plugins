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
| `watch({close: true})` | | closes the conversation when this turn ends, to sleep until a watch wakes it (alone or with a new watch) |

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
- **Restarts.** Commands run under a small detached runner (`runner.mjs`): a background command once, writing its log
  and exit status; a re-run command every `every` seconds, writing each changed output as a numbered change. A
  background command keeps running when Desk restarts or updates a conversation, or when its Pi process stops. A re-run
  command's runner stops with the process unless the conversation is going to sleep (below), and starts again with
  the watch; one gone with a computer restart starts again too. Watches are recorded in the conversation, and are
  picked up again when it next starts: missed output and changes are read from the runner's files, and a time that has
  passed wakes the agent at once, saying when it was due. Output judged, waking the agent or not, is recorded as seen.
- **Sleeping in Desk.** A conversation with watches can sleep: closed with no process, kept in the sidebar, its
  watches going on. The user sleeps it with "Close until needed" (the default for a conversation with watches), the
  agent with `close`. Desk reopens it when a watch has news: a time watch's time (the view's `wakes`), or a change to
  a file a command watch's runner writes (the view's `wakeFiles`: a background command's log and exit status, a
  re-run command's change file), at most every 15 minutes, and after a computer restart. The reopened conversation
  judges the news with `wake_when` and wakes the agent or not; two minutes after it is at rest, Desk closes it again.
  A message from the user keeps it open, and cancels an agent's `close`. Removing a sleeping conversation deletes its
  runners' files, which ends a re-run command's runner. A command watch also marks the view as `watching`, so Desk
  starts the conversation again if its process was lost while it was open. The sidebar shows "Watching" or "Wakes Thu
  09:00"; the composer, an eye with the number of watches, which opens their list.
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
