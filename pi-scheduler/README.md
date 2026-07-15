# pi-scheduler

Schedule a message to be sent back to the current Pi session later, from either `/schedule` or the agent-facing `schedule` tool.

## Usage

```text
/schedule <delay> <message>
/schedule
/schedule list
/schedule cancel <id>
/schedule clear
```

Delays use minutes, hours, or days: `15m`, `5h`, `5.5h`, `30d`.

Scheduled messages are persisted for the current session. If Pi is still open when a message becomes due, it is sent automatically. If Pi is restarted or the session is resumed later, overdue messages for that same session are sent after startup.

Messages created by the agent-facing `schedule` tool are delivered as steering messages when an agent run is active, so the reminder updates the work already in progress. Messages created by the user-facing `/schedule` command are delivered as follow-ups after the active run settles. When the session is idle, either kind starts its turn immediately.

When any messages are queued, a borderless compact scheduler display appears below the editor with countdowns and command reminders. Press `ctrl+o` to expand scheduled entries and read the full messages. Set `PI_SCHEDULER_WIDGET_PLACEMENT=aboveEditor` for a bordered above-editor panel.

Agents can call the `schedule` tool with the same delay syntax to send a future steering message back to the session, which makes it useful for delayed self-reminders or wait-until-later workflows without accidentally queueing a disconnected follow-up turn.
