# Remote access

Linux and Windows computers join one workspace owned by a Google account.
Every signed-in browser uses the same website and discovers its computers,
including offline ones. Sessions and tools stay on their owning computers. Connected computers also share
party discovery, membership and messages through an encrypted host-only channel.
See [Security](SECURITY.md) for the authority and publisher trust boundaries.

## Services

Deploy three distinct origins:

| Service | Contents | Private material |
| --- | --- | --- |
| Static website | Published browser assets and public bootstrap | Publishing credentials, outside the served files |
| Account authority | Standalone Node service and durable device directory | Authority signing key and directory |
| Routing broker | Standalone Node WebSocket service | No owner tokens, authority key or website publishing access |

The Node services require Node 22.19 or later. Copy their bundled executable
and a `package.json` containing `{"type":"module"}` into each deployment.
Neither service needs Pi, a package install or a provider account. Use HTTPS
reverse proxies and one instance of each Node service. The authority's data
directory must survive redeployment. Keep releases and configuration outside
the source checkout.

## Google sign-in

The owner's Google account approves each new computer or browser; nothing else
uses Google. In the Google Cloud console, create a project, configure the Google
Auth Platform for **External** users, add the owner as the only test user, and
create a **Web application** OAuth client whose redirect URI is the authority's
`/auth/google/callback`, for example
`https://account.example.com/auth/google/callback`. The app can stay in testing
mode: approvals use a fresh sign-in, never a stored Google token. Keep the client
ID and secret for the authority's owner file.

## Account authority

Prepare a private configuration file:

```json
{
  "origin": "https://account.example.com",
  "relayOrigin": "https://relay.example.com",
  "appOrigins": ["https://desk.example.com"],
  "workspace": "<a stable workspace name>"
}
```

`workspace` names the workspace permanently: device identities belong to it, so
keep it when the services move. Workspaces created with Microsoft sign-in keep
their original `<tenant>:<owner>` value.

Prepare a private owner file with the Google client and the owner's email:

```json
{ "clientId": "<id>.apps.googleusercontent.com", "clientSecret": "<secret>", "email": "owner@example.com" }
```

The first approval pins the owner's Google account; later approvals must use it.

Generate a private P-256 JWK with `kty`, `crv`, `x`, `y` and `d` fields using
Web Crypto or a JWK-capable key tool. Store it separately from the public app
and broker. Retain it across ordinary redeployments.

```sh
node dist/account/pi-desk-account.js --config /private/account.json --key-file /private/signing-key.json --owner-file /private/owner.json --data-dir /private/account-state
```

Alternatively supply `PI_DESK_ACCOUNT_CONFIG`, `PI_DESK_ACCOUNT_KEY` and `PI_DESK_ACCOUNT_OWNER` as JSON
in that service's private environment, and `PI_DESK_ACCOUNT_DATA` as its
persistent directory. Do not copy these variables into a PC's Pi environment.
The service binds to `127.0.0.1:8930`; `--listen`, `--port` or the deployment's
`PORT` select another binding. Expose only the HTTPS proxy.

`/health`, `/config` and `/.well-known/jwks.json` are public. Every other request
is signed by an enrolled device's key. A new device asks to join at `/enrolments`
and receives an approval link and code; the owner opens the link, signs in with
Google and approves the device after checking the code. Back up the private directory and key together.
Do not restore revoked enrolments from an old backup.

## Routing broker

```sh
node dist/relay/pi-desk-relay.js --account https://account.example.com --origin https://relay.example.com --app-origin https://desk.example.com
```

The broker discovers the authority's public configuration. It binds to
`127.0.0.1:8920`; `--listen` and `--port` can change this. There is no
registration token. PC admission requires a current authority credential and
proof of the enrolled signing key.

For example, a reverse proxy can forward the public origin to the private port:

```caddyfile
relay.example.com {
    reverse_proxy 127.0.0.1:8920
}
```

Preserve Host, Origin and `X-Pi-Desk-App-Origin`, and support WebSocket upgrades.
The broker serves `/health` and routing, not application files or redirects.
Its health response includes release/API information. An outage disconnects
browsers without stopping PC workers. Host-to-host party channels have a separate
signed purpose and authority membership lease; they do not expose browser control
routes. The broker only forwards their encrypted frames. When enabling shared
parties, deploy the updated authority and broker before activating new PC hosts.

## Static app

After building Pi Desk and starting the authority:

```sh
pi-desk publish-app --account https://account.example.com --app-origin https://desk.example.com --output /path/to/new-app-release
```

Publish the new directory to the separate static host. It includes
`desk-account.json`, which selects the authority, and `site.caddy`, the response
headers for a Caddy site (`import site.caddy`); other static hosts must apply the
equivalent CSP and cache rules. Connections are limited to the configured
authority and broker. Do not rewrite missing assets to the application shell.
The bootstrap must not be cached.

Computers follow the services when they move: the website's `desk-account.json`
names the authority, and the authority's `/config` names the broker and website.
Publish the new addresses there and computers reconnect within ten minutes,
keeping their identities; browsers sign in again at a new website address.

The output contains no private signing key or Pi credentials. Its deployment
origins are public runtime configuration, not source defaults. Keep previous
releases outside the published root. Never put the app or its publishing
credentials on the broker.

## Computers and browsers

Install the [personal Pi package and prepare Desk](UPDATING.md), then use its
native commands on each computer:

```sh
/desk signin https://desk.example.com
/desk open
/desk status
```

The stable launcher also accepts the CLI commands below. Use
`node <Pi-agent-directory>/desk/runtime/launch.mjs` in place of `pi-desk` for a
managed installation, or `node dist/host/cli.js` from a development checkout.
`signin` prints an approval link and code and opens the link in the computer's
browser, if it has one; open it in any browser, sign in with the owner's Google
account and approve the computer. It saves the public workspace configuration
and enrols the computer; future starts reconnect to that workspace. `--account` can select the authority directly during initial
deployment. A repeated explicit sign-in can replace a revoked enrolment.
It does not create a second native conversation store.

Open the shared website on desktop or phone and choose **Continue with
Google**, then approve the browser. Every browser gets the same directory after signing in. No
invitations or per-computer pairing steps are needed. Private profiles or
installed web apps with separate storage sign in separately.

Computers are ordinary user processes: no service elevation, inbound firewall
rule or router configuration is needed. The PC must be awake and the user
logged in. Linux needs an unlocked Secret Service; Windows uses current-user
DPAPI. [Login-start](README.md#start-at-login) is optional.

Managed setup can save an approved explicit proxy for both host and account
commands. With the direct CLI, pass `--proxy http://proxy.example.com:8080`
to `signin`/`signout` and to the host's `start`/`serve` or login-start installation.
Otherwise the native clients use standard proxy environment variables and
`NO_PROXY`. `NODE_EXTRA_CA_CERTS` can add an approved PEM CA without disabling
TLS verification. Browser sign-in uses the browser's network configuration.
Hosting under a large provider's domain does not guarantee enterprise access:
the authority, website and WebSockets all need approval.

## Daily use

- Computer names and removals are account-wide. Removing one computer does
  not stop its sessions or affect access to other computers.
- **Browser access** removes a browser enrolment. **Sign out of this browser**
  also clears its local identity.
- `pi-desk signout` revokes this PC's enrolment and refreshes its connector
  without stopping native sessions. It needs the authority to confirm
  revocation; an offline failure is not reported as successful sign-out.
- `pi-desk open --local` provides trusted loopback recovery. Local access
  records are separate from account-wide remote access.
- Install the website with **Install app** or **Add to Home Screen**. Closing
  it does not stop Pi. Clearing its data loses local drafts and the browser's
  identity, not the PCs' saved conversations; revoke unwanted enrolments too.

New conversations, saved history, controls, uploads and file links route to
their owner. An offline computer does not block the others. Unsent drafts stay
on the browser; **Saved drafts** in settings can recover those whose
conversation is no longer listed.

Hidden pages close live connections and reconnect when visible. Reconnect reads
current state but never automatically replays uncertain input. Check history
and Recent operations before repeating it. Compatible release requirements
apply per computer; see [updates](UPDATING.md).

For an acceptance check, sign in on both computers and a fresh browser, verify
both appear without invitations, exercise a conversation on each, then check
revocation and installed-app reopening. A public health response alone does not
verify authentication, proxy support or WebSocket routing. Real workplace and
mobile acceptance cannot be replaced by fixture tests.
