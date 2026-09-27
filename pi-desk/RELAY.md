# Remote access

Each computer opens an outbound connection to one relay. Browsers on Linux,
Windows and phones use the same HTTPS app, which combines sessions from paired
computers in one sidebar. Pi and its tools keep running on their owning computer;
the relay does not run an agent or store conversations.

## Server

Build Pi Desk, then copy `dist/client/` and `dist/relay/` to a server with
Node 22.19 or later, preserving that layout. The standalone relay bundles its
dependencies. It does not require Pi, provider credentials, or `npm install`.
Startup checks the client shell and its referenced assets before listening.
A missing `dist/client/` or entry bundle is a deployment error, not a running
relay with an unusable app.

Generate a registration secret:

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Set it as `PI_DESK_RELAY_TOKEN` in the relay process's private environment.
Keep it for the computer's connector too. Start the server:

```sh
node dist/relay/pi-desk-relay.js --origin https://desk.example.com
```

The relay binds to `127.0.0.1:8920`. Put it behind an HTTPS reverse proxy.
For example, a Caddy site with DNS pointing to this server:

```caddyfile
desk.example.com {
    encode zstd gzip
    reverse_proxy 127.0.0.1:8920
}
```

The proxy must preserve the Host header and support WebSocket upgrades.
`GET /health` returns `status: "ok"` and release/API metadata. Use `--port` or `--listen` when the
server's existing deployment requires another address. Only expose the HTTPS
proxy to the internet.

The server delivering the app is trusted: malicious client JavaScript could
misuse a paired device's credentials. Encryption protects session traffic
from the routing service; it does not make an untrusted app distributor safe.

## Computer

Set the same `PI_DESK_RELAY_TOKEN` in the connector's environment, then run:

```sh
pi-desk serve --cwd /path/to/project --relay https://desk.example.com
```

Run `pi-desk doctor` with the same `--data-dir` after starting the connector.
Its relay check fails until the outbound connection is online; local access
remains independent. Doctor does not open sessions or test provider accounts.

From a source build, replace `pi-desk` with `node dist/host/cli.js`.
The command works as an ordinary user process on Windows and Linux. It does
not install a service, change firewall rules, or require administrator access.
Keep the computer awake and logged in. Optional [login-start](README.md#start-at-login)
saves the connector's startup options and selected environment privately; it is
not a prerequisite for this connector.

For an explicit proxy:

```sh
pi-desk serve --relay https://desk.example.com --proxy http://proxy.example.com:8080
```

Standard proxy environment variables and `NO_PROXY` are also supported when
`--proxy` is omitted. TLS verification remains enabled. Use your organization's
approved certificate and proxy configuration; the connector does not override
workplace policies. Local access remains available if the relay is unreachable.
If Node lacks an approved certificate authority, `NODE_EXTRA_CA_CERTS` can
point to its PEM file. Restart the connector after changing it. This adds
trusted authorities without turning certificate or hostname checks off.

## Pair a device

Open the local pairing link printed by the host. In **Settings & tools → Device
access**, choose **Pair a phone or another device**, then open that invitation
on the other device within ten minutes. Invitations grant access to Pi and its
tools under the computer's OS account.

The secret is in the URL fragment, not a request URL or relay log. On first
connection, the invitation is exchanged for a fresh, persistent device key.
The browser saves that key before claiming the invitation, so losing an
acknowledgement does not lose the pairing. Reloading or reconnecting does not
require another invitation. Private browsing does not retain keys after its
browser context closes.

Revoke a device from **Device access**. Revocation closes its current connection
and rejects later requests. Do not copy the computer's Desk access file to
another machine: each computer owns its identity, sessions and device records.

### Several computers

Connect each computer to the same relay. In the shared app, open **Settings &
tools → Computers → Connect another computer**, or open that computer's
invitation. Adding it keeps existing pairings. Pairing is per browser and
computer; it is not a server account shared between devices.

Sessions appear together, grouped by computer. New conversations let you choose
a connected computer and a folder on that computer. Saved sessions, controls,
uploads and file links are routed to their owner. Drafts and reading positions
are separate even when two computers have identically named sessions.

Computer names can be changed for the current browser. Expand a computer in
settings to manage its device access. **Forget computer** removes that browser's
stored pairing and disconnects it; it does not stop work or revoke other devices.
An offline or revoked computer does not block access to the others.

## Install the app

Open the shared HTTPS address in a normal browser profile, pair the computers,
then use the browser's **Install app** or **Add to Home Screen** action. On a
computer, choose to open it in its own window. A phone needs only the browser
or installed web app; Pi stays on the paired computers.

Mobile browsers may give an installed app separate storage. If it opens
unpaired, create fresh invitations and pair from that app window. Keep using
the same server address: a different hostname or port is a different browser
storage location.

Closing an app window does not stop Pi. Reopen it to reconnect to available
computers. Removing the app is also separate from stopping the hosts; the
browser may offer to delete website data during removal. Deleting that data
loses local pairings and unsent drafts, not the computers' saved conversations.

For a deployment check, open the app through the actual HTTPS proxy, connect
both computers and reopen an installed app window. Check `doctor` on each
computer. A successful `/health` response alone does not verify WebSocket
routing or browser pairing.

## Connection behavior

Each connection uses fresh nonces from both endpoints, HKDF-separated direction keys,
and AES-GCM with strictly increasing counters. Tampered, reordered and replayed
frames are rejected. Large messages are chunked and bounded. The relay sees
connection metadata and encrypted frames, but not Pi requests or results.

Disconnecting a browser or restarting the relay does not stop the worker.
The app reconnects and reads current state. It does not automatically replay
unacknowledged prompts or actions: check the conversation when delivery is
uncertain. A host crash is different from a relay outage; arbitrary tools
cannot safely be replayed after a host restart.

Hidden browser pages close their live connections and reconnect when visible.
Event delivery acknowledgements also bound a frozen browser's outstanding
backlog. Overload disconnects are retryable and do not revoke device keys.
Update the app server and connectors to compatible releases; API/protocol
mismatches are reported for the affected computer rather than requesting another
pairing. The same applies to a tab still running an older app. Reload that tab
after the update. A healthy computer remains usable while another needs an update.
See [updates and removal](UPDATING.md) for the rollout sequence.

For local development only, loopback HTTP relay origins are accepted. All
other relay origins must use HTTPS.
