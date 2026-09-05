# pi-scheduler

Schedule a message to be sent back to the current Pi session later, from either `/schedule` or the agent-facing `schedule` tool. Agents can cancel pending messages with `cancel_scheduled_message` and the id returned by `schedule`.

## Usage

```text
/schedule <delay> <message>
/schedule
/schedule list
/schedule cancel <id>
/schedule clear
/schedule migrate
```

Delays use minutes, hours, or days: `15m`, `5h`, `5.5h`, `30d`.

Scheduled messages are persisted for the current session. Delivery runs every five seconds in a live TUI or RPC session. Print and JSON runs reject scheduling because they exit after their prompts. If Pi is restarted or the session is resumed later, overdue messages for that same session are sent after startup.

Due messages are delivered as labelled Pi custom messages, not as newly typed user messages. Their model-facing content states that the scheduler queued and delivered them automatically. All reminders steer an active run, so they update work already in progress rather than wait for a separate follow-up. When the session is idle, a reminder starts a turn immediately.

When any messages are queued, a borderless compact scheduler display appears below the editor with countdowns and command reminders. Press `ctrl+o` to expand scheduled entries and read the full messages. Set `PI_SCHEDULER_WIDGET_PLACEMENT=aboveEditor` for a bordered above-editor panel.

Agents can call `schedule` with the same delay syntax to send a future steering message back to the session. They can later call `cancel_scheduled_message` with the returned id (or an unambiguous prefix), or with `all`, when the reminder is no longer needed. Cancellation succeeds only before a delivery process claims the reminder.

## Storage and recovery

Requires Node.js 22.19 or newer with built-in `node:sqlite`. Each session has a SQLite database in `~/.pi/agent/scheduler` (override with `PI_SCHEDULER_DIR`). Use a local filesystem on one machine: process ownership is checked by PID, and SQLite transactions serialize scheduling, cancellation, and exclusive delivery claims. Corruption is reported rather than treated as an empty queue.

A reminder stays claimed until its ID appears in the saved session transcript. A crashed process's claims are recovered on the next delivery tick; graceful shutdown releases unacknowledged claims. PID reuse can conservatively delay recovery until that process exits. SQLite rolls back interrupted storage transactions. Ephemeral sessions use in-memory admission and cannot recover their transcript after exit.

Pi's `sendMessage` API returns before durable admission and does not expose asynchronous delivery failures to this extension. A claim with no transcript acknowledgement therefore remains pending until the owning session reloads or exits; it is not silently deleted or repeatedly sent. Recovery is at-least-once, not an exactly-once guarantee across delivery and transcript persistence. The stable schedule ID identifies a repeated delivery.

For a one-time cutover, stop Pi processes using the JSON scheduler, load the new extension, and run `/schedule migrate` in TUI mode. After confirmation, it imports every session's version-2 reminders into SQLite and retains the original JSON as a backup. Partial imports can be retried without duplicate rows. Normal scheduling stays blocked while the original JSON exists, so pending reminders cannot be silently discarded. Do not run old and new scheduler versions together during cutover.
