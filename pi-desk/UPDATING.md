# Installation and updates

Pi Desk requires Node 22.19 or later, npm and a private user directory on Windows
or Linux. Install this repository as a **personal Pi package**:

```sh
pi install git:github.com/gunba/pi-plugins
```

Restart Pi to load its new commands. Run `/desk setup`, then `/desk signin` with
your workspace's HTTPS address. `/desk open` starts the host and opens that
workspace. Sign into the same Microsoft account on each computer and browser.
See [remote access](RELAY.md) if the shared services are not deployed yet.

## Setup

`/desk setup` prepares an isolated runtime from the installed package and its
lockfiles. The first build downloads dependencies and can take several minutes.
It does not alter the global Pi CLI. Desk pins its own Pi SDK.

Choose the existing Desk data directory when migrating, or keep the default
`<Pi agent directory>/desk`. Account configuration, protected credentials and
native sessions remain in place. If saved login-start settings exist, setup
keeps their options and selected environment values. Otherwise, native dialogs
let you choose the default project, port, session directory and proxy.

The default port is 8910; zero selects an available loopback port. Leaving the
session directory empty uses native Pi settings/environment. Leaving the proxy
empty uses the normal proxy environment. The Pi agent directory comes from the
current Pi installation, including `PI_CODING_AGENT_DIR` if set.

Microsoft's protected-cache library needs its native `keytar` binding. Setup
performs the targeted rebuild after installing other dependencies without
lifecycle scripts. An approved prebuilt binary normally avoids compilation;
otherwise a supported native build toolchain is needed. Linux also requires
libsecret and an available, unlocked desktop Secret Service. Windows uses
current-user DPAPI. There is no plaintext credential fallback.

Ordinary use does not need elevation, an inbound firewall rule or a VPN.
Organizational execution/network policy still applies. Native dependencies or
Secret Service setup may need IT help; do not disable protection to bypass it.

`/desk login install` optionally starts the host at user login. Linux uses a
user service; Windows uses a current-user limited-token scheduled task. The
account must remain logged in and the computer awake. Removing login-start
does not delete native history or sign out of the workspace.

## Routine updates

| Command | Effect |
| --- | --- |
| `/desk` | Open the native management menu |
| `/desk status` | Show host, active/staged versions and latest operation outcome |
| `/desk stage` | Prepare the currently installed source without updating it |
| `/desk update` | Use Pi's package manager to update this personal package, then prepare it |
| `/desk restart` | Confirm closure of all conversations, select the staged version and start the host |
| `/desk rollback` | Confirm closure and select the previous prepared runtime |
| `/desk stop` | Stop the host and its workers; keep native history |
| `/desk login` | Inspect, install or remove login-start |

These are native extension commands in both Pi and Desk. Restart and login
changes run outside their initiating conversation, so closing that worker does
not cancel the operation. Reconnect and use `/desk status` to check its outcome.
Admission is not completion. Failed or unconfirmed operations are not retried.

Normal interactive Pi startup stages changes in the background after a Pi
package update. It does not fetch updates itself, block Pi startup or restart
the host. Managed Desk workers, children and offline startup skip this step.
A previous failed/unconfirmed operation asks for attention instead of being
overwritten by automatic staging.

Each prepared version has its own first-party source, SDK, dependencies and
build output. Running workers and late child loads retain that version when Pi
updates the installed source. Third-party packages still use native discovery;
this isolation does not freeze their updates.

Staging does not activate a release. When ready, finish work or explicitly
accept its closure, then run `/desk restart`. Questions, tools, children and
automatic plans count as live work even when the main conversation is idle.
History stays closed after restart; resume it explicitly. No restart replays
unfinished prompts or controls. Check receipts/history before repeating
uncertain work.

Native package behavior applies: offline mode does not fetch, pinned sources
keep their configured revision, and local development paths are not fetched.
`stage` and `update` can therefore report the same version. Versions are not
automatically removed.

After changing Node, restart terminal Pi with the new executable and run
`/desk stage`, then `/desk restart`. Preparation can use the existing JavaScript
controller without loading its old native bindings. The running host keeps its
old runtime until the explicit restart. Login-start then records the new Node
path while retaining its other settings. A restart or rollback to an incompatible
runtime is refused **before** stopping the current host; stopping alone remains
available from either Node version.

## Moving from an unmanaged installation

1. Record the old executable, Node path and startup options. Preserve the Pi
   agent directory, native sessions, Desk data and OS protected store.
2. Finish work or deliberately stop it with the **old** executable's `stop`,
   using the same `--data-dir`. Confirm it reports stopped. Do this before
   updating first-party source under old workers.
3. Keep an existing `login.json`; do not remove login-start just to migrate.
   Update the personal Pi package, restart terminal Pi, and run `/desk setup`.
   Choose the old data directory. If there was no saved login configuration,
   enter the recorded project, port, session directory and proxy in the dialogs.
4. Setup retargets a stopped, owned login entry to the stable launcher, retaining
   its arguments, environment and enabled state. A private
   `login-before-managed.json` holds the previous configuration. A running or
   unresponsive host is not force-killed or treated as safe to replace.
5. Run `/desk open`, check status/resource diagnostics, then explicitly resume
   selected conversations. The existing computer identity should remain;
   use sign-in only if authorization is actually missing.

Version 0.4 uses API 4 and first-party presentation version 2. Deploy matching
website, account and broker artifacts before treating the cutover as complete.
Older computers may temporarily show **Update required**. A version mismatch
is not a reason to delete sessions, credentials or drafts.

Keep the website origin to retain browser storage. If it changes, export drafts
and files first. Do not copy `login.json`, signing keys or protected caches
between computers. Initial migration still requires local access to stop/update
an unmanaged host; subsequent managed updates use `/desk`.

## Recovery and rollback

The stable launcher is `<Pi agent directory>/desk/runtime/launch.mjs`. It uses
the saved installation defaults and accepts the normal lifecycle commands:

```sh
node /path/to/agent/desk/runtime/launch.mjs status
node /path/to/agent/desk/runtime/launch.mjs doctor
node /path/to/agent/desk/runtime/launch.mjs stop
```

On Windows, use `node "$HOME\.pi\agent\desk\runtime\launch.mjs" status` for the
default agent directory. No PowerShell package shim is required. Keep local
recovery links from `open --local` private.

`/desk rollback` changes code, not data. Check that the earlier SDK and plugins
can read current native sessions; it is not a session-file downgrade. Keep
compatible service/browser artifacts for API rollbacks. Preserve the authority
directory/signing key rather than restoring revoked enrolments.

`operation.json`, `operation.log` and `stage.log` live under the private runtime
directory. Host logs remain in the data directory. Do not publish these files:
installation paths and dependency diagnostics can contain private details.
Do not edit active version directories or replace the launcher under a host.
See [managed runtimes](manage/README.md) for selection and locking.

## Build and deploy shared services

From `pi-desk/` in a trusted checkout:

```sh
npm ci --ignore-scripts
npm rebuild keytar
npm run typecheck
npm run build
```

Stop development hosts before rebuilding their executable output. Publish the
account, broker and website as separate artifacts using [RELAY.md](RELAY.md).
Generate website configuration with `publish-app --account …`; deployment
addresses are not source defaults. Preserve the authority's private directory
and signing key. A broker restart disconnects browsers but does not stop native
workers. Publishing the website does not update PCs.

## Remove

Remove the computer from a trusted signed-in browser, or run `signout` through
the stable launcher while the authority is available. Use `/desk login remove`
if configured, then `/desk stop` and confirm the host is stopped. Only then
remove the runtime directory. The old standalone application package, if any,
can also be uninstalled after confirming nothing still launches it.

Keep native sessions, the agent directory and Desk data unless intentionally
deleting them. Submitted files under `desk/attachments/` may still be referenced
by saved conversations. Other Pi plugins need not be removed.

Browser-app removal is separate. Sign out or revoke the browser first; clearing
site data alone is not account-wide revocation. It deletes local drafts, not
host conversations. Microsoft sign-in sessions are managed separately.

## Release checks

`doctor` reports app/SDK versions, assets, directories, login-start, host API
and remote connectivity without printing secrets. It does not start workers,
verify Microsoft login or test model accounts. A deliberately stopped host is
a warning; failed checks return status 1.

Verify protected-store persistence on the target platform. CI's Windows DPAPI
check does not establish workplace approval, browser OAuth or proxy acceptance.
Headless Linux CI cannot establish an unlocked desktop keyring. Real Windows
login-start and physical-phone acceptance remain separate release checks.

Breaking application DTO changes increment `API_VERSION` in
`src/shared/release.ts`. Local requests and remote handshakes bind that revision.
Process management has its own record contract, so stopping a host does not
depend on browser API compatibility.
