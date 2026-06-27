# pi-browser

Minimal browser UI for Pi sessions.

```bash
PI_BROWSER_TOKEN=$(openssl rand -hex 24) pi-browser --host 0.0.0.0 --port 8080
```

Open the browser UI from another device:

```text
http://<host>:8080/#token=<token>
```

The app stores the token in browser local storage and uses it only for API calls, so there is no token-cleanup redirect.

## Goals

- Simple Pi-in-a-browser experience
- Mobile-friendly PWA
- Multiple browser tabs can watch/control the same RPC worker
- Desktop/TUI Pi sessions register with the browser after `/reload`, then can be watched and steered from the PWA
- New browser workers start from a tap-friendly workspace picker with recent folders, directory browsing, and folder creation
- Existing session files open from a cached recent-session index and load the latest transcript window first
- Terminal-style transcript rendering with assistant markdown, lazy collapsed tool rows, and diff-highlighted code blocks
- Portrait/mobile layout keeps the terminal full-width/full-height and moves workers/sessions into a pop-out sidebar
- Android voice dictation works through the normal keyboard microphone in the composer

## Performance tuning

The server caches the recent-session index and the browser polls worker status separately from session history so active pages stay responsive. Desktop session views use incremental file reads after the initial transcript window.

Useful environment knobs:

- `PI_BROWSER_SESSION_LIST_CACHE_MS` — recent-session cache duration, default `30000`
- `PI_BROWSER_MAX_SESSION_FILES` — maximum recent session files indexed, default `240`
- `PI_BROWSER_SESSION_TAIL` — initial transcript window size, default `250`
- `PI_BROWSER_MAX_SNAPSHOT_EVENTS` — worker events sent on browser reconnect, default `250`

## Notes

`pi-browser` starts headless `pi --mode rpc` workers for browser-controlled sessions. Existing desktop/TUI sessions can be viewed from their JSONL session file, but a separate running terminal Pi process cannot currently be driven directly by browser input without Pi core support for cross-process session control.
