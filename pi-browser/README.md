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
- Existing session files can be browsed and refreshed
- Android voice dictation works in the composer; supported browsers also get a push-to-talk button via Web Speech API

## Notes

`pi-browser` starts headless `pi --mode rpc` workers for browser-controlled sessions. Existing desktop/TUI sessions can be viewed from their JSONL session file, but a separate running terminal Pi process cannot currently be driven directly by browser input without Pi core support for cross-process session control.
