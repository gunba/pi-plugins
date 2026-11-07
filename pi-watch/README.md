# Watch

One tool, `watch`, for waiting without spending turns. The agent starts a watch and ends its turn; the watch wakes it
with what happened. It replaces sleep loops, repeated checks and waiting on a long command in the foreground.

| Call | Watches | Wakes the agent |
|---|---|---|
| `watch({command})` | the command, run in the background | with its new output, and when it ends |
| `watch({command, every})` | the command, re-run every `every` seconds | when its output changes; the watch then ends, or with `keep` goes on and wakes it for each later change |
| `watch({program, every})` | a program, as for codemode, re-run every `every` seconds | when its result changes; the watch then ends, or with `keep` goes on |
| `watch({until})` | the clock: a delay such as `90s`, `5m` or `2h`, `HH:MM`, or an ISO date and time | at that time |
| `watch({})` | | lists the conversation's watches |
| `watch({stop})` | | stops a watch and its command |
| `watch({close: true})` | | closes the conversation when this turn ends, to sleep until a watch wakes it (alone or with a new watch) |
| `watch({command or program, computer, cwd})` | the command or program on another of Jordan's computers, in `cwd` there (default: its home folder) | as above, once Jordan has approved it |

`wake_when` describes, in plain words, which events should wake the agent ("the build fails or finishes"). A
classifier model judges each event: TypeSafe's Jev when signed in (`/login typesafe`), otherwise another signed-in
classifier. A watch with `wake_when` can't be started without one. If the classifier fails during a watch, the event
wakes the agent anyway with a note; after three failures in a row the watch ends.

## Desk runs the watches

Where Desk runs, it runs the computer's watches, not the conversations they wake (`pi-desk/src/host/watches.ts`). A
Pi process in Desk, or in a terminal on a computer whose Desk is running, asks Desk for a watch and gets its events
from Desk (`desk.ts`); the watch, its runner and its events live in Desk's store,
`~/.pi/agent/party/watches.sqlite`. So:

- A watch goes on while its conversation closes, restarts or updates, and while Desk itself restarts. A conversation
  can sleep with any watch, a program watch included.
- An event waits in the store until the agent's Pi process has put it in the conversation. A conversation that isn't
  running when one arrives is reopened for it, from its file if Desk didn't list it; one asleep by choice closes
  again once it is at rest. One that can't be reopened is tried again every 15 minutes.
- Desk judges `wake_when` with the classifier signed in on the computer running the watch.
- Program watches run in a background Pi process Desk keeps for each folder with program watches, with that folder's
  tools and settings. No one sees it, so a question or approval asked during a run is refused at once, and the run
  carries on with the refusal. A program there can't start watches, and a `bash` command in it runs to its end within
  the run's 2 minutes or is stopped.
- Each computer's settings page lists the watches Desk runs there and those its agents asked other computers to run;
  Jordan can stop any, and its agent is told. The Stop action in a conversation's watch list does the same.
- Removing a conversation from the sidebar, an agent closing it without `keep`, or a move to another computer ends
  its watches, here and on other computers; no one is told then. When the conversation next runs, its agent is told
  which watches ended and why.
- Watches a conversation ran itself before Desk did are handed to Desk when it next starts, under the same names,
  following the same runners and files.

Without Desk, as in Pi in a terminal on a computer where Desk isn't running, the conversation runs its watches itself,
as described under Behaviour: they last while its process does and are picked up again when it next starts.

### Other computers

`computer` names another of Jordan's computers, by name or ID as `agent_list` shows them, that runs this version of
Desk or later; `cwd` is the folder there. Before anything is sent, Jordan approves the watch in the conversation, with
the command or program, the folder and the schedule shown. The watch then runs there, judged by that computer's
classifier, and its events come back over Desk's connection between the computers and wake the agent as a watch here
would. Only commands and programs run on another computer; a time watch wakes the agent from its own. The agent can
stop it with `watch({stop})`, and Jordan from either computer's settings page. A request the other computer hasn't
answered in 10 minutes ends, and so do the watches of a computer that leaves the workspace; the agent is told.

## Watch versus wake

`watch` is the single subscription primitive. There is no separate `wake` tool or second scheduling store:

- `command`, `every`, and `until` choose the event source; `wake_when` optionally filters command events with a classifier.
- In Desk, the watch's state is in Desk's store, and the conversation's `pi-watch/v1` session entries only record which watches it has had there. Without Desk, the watch owns its state in those entries. All modes use the same pending-event delivery path: while the agent is working, events join its run at the next step; otherwise they start a turn once the agent is idle with no pending input.
- Desk's `wakes`, `watching`, and `wakeFiles` fields are process-lifecycle hints, not another task queue: Desk uses them to reopen conversations whose watches run in their own process, as those of older versions do. Reopening a process is not itself an instruction to the model.
- `agent_send({wake: true})` is a message-delivery option: act on this message when possible, reopening a closed recipient if necessary. It does not create a timer or watch. Secondary-agent reports use their parent runtime's delivery path for the same reason.
- Historical `pi-work/wake-v1` and scheduler messages remain readable in Desk transcripts. Their readers do not register another waiting tool or run an old scheduler.

### One-off, polling, and recurring work

Use `watch({until: "09:00", close: true})` for a one-off wake at the next 09:00 on this computer. Use an ISO timestamp with an explicit offset when a particular date or time zone matters. `close` is optional and changes only whether Desk may close the conversation while it waits.

A watch doesn't pause a program: it returns at once and wakes the agent after its turn. From a program, `until` less than a minute away is refused, since it can only be an attempt to pause; a program looping to wait for a page had set ten such watches, which all woke the agent together.

Use `watch({command: "git ls-remote origin HEAD", every: 300})` to poll a programmatic event source. The first output establishes a baseline; a changed output wakes the agent and ends the watch. With `wake_when`, the classifier also evaluates the first result and can wake immediately if it already matches. `every` is the polling interval, **not** a recurring timer that starts a model turn on every tick.

For recurring calendar work, use successive time watches through the same tool. On each wake, schedule the next occurrence before carrying out the current task, then end the turn when finished. This keeps future work scheduled even if the current task fails. It also lets the agent account for calendar dates and daylight-saving changes rather than treating a week as an elapsed-seconds timer. No cron job, OS task, or second wake primitive is needed.

These watches wake conversations, not powered-off computers. The host must be running to reopen a conversation; an overdue time watch is delivered when Desk next runs. Stopping a watch or removing its conversation cancels future automatic reopening.

## Program watches

`watch({program, every})` re-runs a program instead of a command, so a watch can check anything an operation reaches,
such as a mailbox or a web service, without spending turns. Its results are judged as a re-run command's output: the
first sets the baseline (or wakes the agent if `wake_when` already holds), and a changed result wakes it and ends the
watch.

- pi-tools runs the program (its `RUN_PROGRAM` event). In Desk, it runs in Desk's background process for the folder
  (above), with a context of its own, so its operations pass through that folder's guards.
- A run may take 2 minutes; one stopped then, or failed, has that as its result.
- Without Desk, it runs in the conversation's process, with the context of the agent's latest `watch` or `bash` call,
  as Pi offers no context outside a call. The conversation can't sleep while one is active (`close` is declined), and
  a restart leaves it without a context: one interval after the restart, the agent is told once, and the watch resumes
  when the agent next calls `watch` or `bash`.
- Runs don't appear in Desk's transcript: Desk shows nested calls only under a running call.

## bash

pi-watch also provides Desk's `bash`, in place of Pi's. Its command runs under the same detached runner, so it can
outlive the call, and several calls in one program run at once.

| Parameter | Default | |
|---|---|---|
| `command` | | the command, run in the working directory with Pi's environment and `shellCommandPrefix` |
| `wait` | 60 | seconds the call waits for the command to end, at most 60; 0 starts it in the background at once |
| `warn` | 1800 | seconds between wakes while it runs in the background; 0 wakes the agent only at its end |
| `progress` | | a command printing how far it is, such as a count of results, run each minute in the background |

A command that ends within `wait` returns as Pi's bash does: `{output, truncated, full_output_path?, exit_code,
wall_time_seconds}`, an error with the exit code when it is not 0, and its last 2,000 lines or 50 KB for the model. A
program receives up to 1 MiB of output, or its first and last 512 KiB with the full output's path. A fast command
leaves no files. One still running after `wait`, or when Jordan sends a steering message (which reaches the agent
only once its calls return), goes on as a watch, so no command holds up a turn for more than a minute: the call returns its output so far with
`exit_code: null` and `running` (the watch's ID). The watch wakes the agent when the command ends, with its exit status,
running time and progress, and every `warn` seconds while it runs, with its latest output and progress readings, so
the agent can judge whether it is getting anywhere and stop it with `watch({stop})`. Nothing stops a command for
taking long. New output alone doesn't wake the agent. Desk's view of the watch shows when it started and its latest
progress. Pi's `timeout` parameter is accepted and ignored, and agents are told not to wrap commands in `timeout`, which
would only cut short a command that can run on.

## Behaviour

- **Output.** A background command's output arriving within 2 seconds is judged as one event, and a wake carries at
  most 4,000 characters of it. The full output stays in the log file named in the result, under
  `~/.pi/agent/watch/desk/` for a watch Desk started and `~/.pi/agent/watch/<session>/` otherwise. When the command ends, the agent is always woken with its exit status and last 20
  lines.
- **Timing.** An event that arrives while the agent is working joins its run at the next step, after the tool calls
  under way, so the agent knows before it answers and the event does not start a turn of its own later. An event
  that arrives once the run is over, or while Desk holds the conversation, starts a turn when the agent is idle with no
  input waiting; events waiting together are delivered as one message.
- **Lifetime.** There is no time limit. A command watch runs until its command ends, it wakes the agent (a re-run
  command, unless `keep`), or the agent or the user stops it; `hours` gives it an end if the agent wants one, and a background command
  still running then is stopped. A time can be any time ahead. Times are checked against the clock every minute, so a
  computer that slept still acts on time.
- **Restarts.** Commands run under a small detached runner (`runner.mjs`): a background command once, writing its log
  and exit status; a re-run command every `every` seconds, writing each changed output as a numbered change. On Linux
  the runner raises its OOM score to 800, which its command inherits, so when memory runs out the kernel kills the
  watched command before Pi. A background command keeps running when Desk restarts or updates a conversation, or when its Pi process stops. A re-run
  command's runner stops with the process unless the conversation is going to sleep (below), and starts again with
  the watch; one gone with a computer restart starts again too. Watches are recorded in the conversation, and are
  picked up again when it next starts: missed output and changes are read from the runner's files, and a time that has
  passed wakes the agent at once, saying when it was due. Output judged, waking the agent or not, is recorded as seen.
- **Sleeping in Desk** (watches a conversation runs itself, in older versions). A conversation with watches can sleep: closed with no process, kept in the sidebar, its
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
- **Moves.** A conversation moved to another computer doesn't take its watches along: they end, and its agent is told
  when it starts there.
- **Limits.** A conversation can run at most 8 command watches, which each run a process, and 64 time watches at once,
  and 8 command watches on each other computer; bash commands in the background don't count. `pi-plan` holds automatic plan rounds while any
  watch is active.
- **Status.** Desk shows a "Watching" badge by the message box; its view lists the watches with a Stop action. The
  terminal shows `watching N` in the footer.

Files of watches that ended more than 8 days ago are removed: by Desk every hour, and otherwise when a conversation
starts. Desk forgets news delivered a day ago and watches that ended 30 days ago.
