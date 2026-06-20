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
- Existing session files can be browsed and refreshed
- Terminal-style transcript rendering with assistant markdown, tool rows, and diff-highlighted code blocks
- Portrait/mobile layout keeps the terminal full-height and moves workers/sessions into a pop-out sidebar
- Android voice dictation works through the normal keyboard microphone in the composer

## Notes

`pi-browser` starts headless `pi --mode rpc` workers for browser-controlled sessions. Existing desktop/TUI sessions can be viewed from their JSONL session file, but a separate running terminal Pi process cannot currently be driven directly by browser input without Pi core support for cross-process session control.
