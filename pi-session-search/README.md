# pi-session-search

Exact modal search and resume for Pi sessions.

## Command

```text
/session-search [query]
```

The modal searches all saved Pi sessions by default with literal AND matching. Quoted text searches exact phrases, `re:<pattern>` runs a regular expression, and filters such as `cwd:`, `name:`, `id:`, `path:`, `days:`, `after:`, and `before:` narrow results. Press `Ctrl+A` to launch a background agent for natural-language session hunts.

## Keys

- `Enter` — resume the selected session
- `Tab` — toggle all sessions/current cwd
- `Ctrl+R` — refresh the cached session index
- `Ctrl+P` — toggle session paths in result rows
- `Ctrl+A` — send a background agent to search Pi/Codex/session memory
  and write a ranked report
- `Ctrl+U` — clear the query
- `Esc` — close
