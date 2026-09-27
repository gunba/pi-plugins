# Remote access

Linux and Windows computers sign into one Microsoft-account-owned workspace.
Every signed-in browser uses the same website and discovers its computers,
including offline ones. Sessions and tools stay on their owning computers.
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

## Microsoft registration

Create a single-tenant Microsoft Entra application and service principal:

- Configure v2 access tokens and expose the delegated `Workspace.Access` scope.
  Permit the chosen owner's account to consent, or grant consent through the
  organization's administrator.
- Register the website's exact `/auth/redirect.html` URL as a **SPA** redirect.
  Register `http://localhost` for the **mobile/desktop public client** flow.
  Enable public-client flows; do not create a client secret or enable implicit
  token flows.
- The same application is the public client and API resource. Clients request
  `<client-id>/Workspace.Access`, using the GUID resource form, not a Graph
  scope. Keep the tenant, application ID and immutable owner object ID.

Use the tenant-specific authority, not `common`. The service checks the owner
object ID, not a display name or email. Add temporary localhost SPA redirects
only for development and remove them afterward. A Static Web Apps login gate
alone does not authorize independent PC connectors.

References: [redirect URI rules](https://learn.microsoft.com/entra/identity-platform/reply-url),
[delegated scope validation](https://learn.microsoft.com/entra/identity-platform/scenario-protected-web-api-verification-scope-app-roles),
[MSAL redirect bridge](https://github.com/AzureAD/microsoft-authentication-library-for-js/blob/dev/lib/msal-browser/docs/redirect-bridge.md).

## Account authority

Prepare a private configuration file:

```json
{
  "origin": "https://account.example.com",
  "relayOrigin": "https://relay.example.com",
  "appOrigins": ["https://desk.example.com"],
  "tenantId": "<tenant-guid>",
  "clientId": "<application-guid>",
  "ownerObjectId": "<owner-object-guid>"
}
```

Generate a private P-256 JWK with `kty`, `crv`, `x`, `y` and `d` fields using
Web Crypto or a JWK-capable key tool. Store it separately from the public app
and broker. Retain it across ordinary redeployments.

```sh
node dist/account/pi-desk-account.js --config /private/account.json --key-file /private/signing-key.json --data-dir /private/account-state
```

Alternatively supply `PI_DESK_ACCOUNT_CONFIG` and `PI_DESK_ACCOUNT_KEY` as JSON
in that service's private environment, and `PI_DESK_ACCOUNT_DATA` as its
persistent directory. Do not copy these variables into a PC's Pi environment.
The service binds to `127.0.0.1:8930`; `--listen`, `--port` or the deployment's
`PORT` select another binding. Expose only the HTTPS proxy.

`/health`, `/config` and `/.well-known/jwks.json` are public. `/workspace`
requires the owner's delegated access token; device mutations also require
proof of the enrolled key. Back up the private directory and key together.
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
browsers without stopping PC workers.

## Static app

After building Pi Desk and starting the authority:

```sh
pi-desk publish-app --account https://account.example.com --app-origin https://desk.example.com --output /path/to/new-app-release
```

Publish the new directory to the separate static host. It includes
`desk-account.json`, which selects the authority, and generated
`staticwebapp.config.json` headers for Azure Static Web Apps. Other static hosts
must apply the equivalent CSP and cache rules. Connections are limited to the
configured authority, broker and Microsoft sign-in endpoints. The redirect
bridge must remain a separate document; do not rewrite missing assets to the
application shell. Bootstrap and auth callbacks must not be cached.

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
`signin` reuses its saved authorization, or opens Microsoft in the computer's
browser and lets Microsoft reuse an existing session. It saves the public
workspace configuration and enrols the computer; future starts reconnect to
that workspace. `--account` can select the authority directly during initial
deployment. A repeated explicit sign-in can replace a revoked enrolment.
It does not create a second native conversation store.

Open the shared website on desktop or phone and choose **Continue with
Microsoft**. Every browser gets the same directory after signing in. No
invitations or per-computer pairing steps are needed. Private profiles or
installed web apps with separate storage sign in separately.

The browser and background connector hold separate authorizations; they do not
copy tokens between stores. Using the same browser profile lets Microsoft SSO
avoid another account/password prompt. MFA, expired sessions or another browser
profile can still require interaction.

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
Microsoft endpoints, the authority, website and WebSockets all need approval.

## Daily use

- Computer names and removals are account-wide. Removing one computer does
  not stop its sessions or affect access to other computers.
- **Browser access** removes a browser enrolment. **Sign out of this browser**
  also clears its local identity and MSAL cache, not all Microsoft sessions.
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
