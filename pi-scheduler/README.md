# pi-scheduler

Schedule a user message to be sent back to the current Pi session later.

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

When any messages are queued, a compact scheduler panel appears above the editor with countdowns and command reminders.
