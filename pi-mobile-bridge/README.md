# Phone bridge

Every foreground Pi TUI automatically advertises itself through a private local
socket. The first running Pi process hosts a small web page on `127.0.0.1:8911`;
if it closes, another Pi process takes over the same port. The page lists all
running desktop Pi terminals and lets you switch between them. Each message
or `ask_user` response goes to the selected process through its private socket:
no second Pi process writes the same session file.

The selected terminal's page shows its recent conversation, streaming answer,
active tools, and Goal/Todo/Subagent/Party work-panel status. Other terminals
show their idle, working, or waiting-for-answer state in the session selector.
An `ask_user` question can be answered from the phone after pairing. If a phone
question needs to return to the desktop, run `/phone-desktop` in that terminal.

## Phone access

Tailscale Serve can expose the loopback page on a private tailnet without
opening a public port. Mount it at `/pi` on an existing HTTPS route without
changing that route's root service:

```sh
tailscale serve --bg --https=443 --set-path=/pi http://127.0.0.1:8911
```

Open `https://<machine>.<tailnet>.ts.net/pi/` on a phone signed into the same
tailnet. Run `/phone-token` in any Pi terminal to see the URL and pairing token.
The token is shared among this machine's Pi terminals, stored in an owner-only
file under `~/.pi/agent/mobile-bridge/`, and sent in an authorization header,
not a URL. The browser keeps it in tab session storage. `/phone-reset` rotates
it. Do not use Tailscale Funnel or expose port 8911 to the public internet.

To remove only the Pi route while preserving the existing root service:

```sh
tailscale serve --https=443 --set-path=/pi off
```

The PC must stay awake and at least one foreground Pi terminal must remain
open to host the page. Each terminal stops appearing when its Pi process exits.
Restart or `/reload` a Pi process that predates installation so it can register.
The browser does not run slash commands, upload images, replay full tool
outputs, or render unrelated custom terminal components. It can show and
answer `ask_user` questions; other TUI-only dialogs still require the desktop.

The bridge starts only in interactive desktop Pi sessions. SDK children do not
host web pages or register as controllable terminals. The local socket and
session records are cleaned up on orderly shutdown; crashed processes expire
from the list after 30 seconds. Tailscale Serve is configured independently
and may remain mounted while no Pi process is running.
