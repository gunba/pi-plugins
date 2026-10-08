# Installation and updates

Pi Desk requires Node and a private user directory on Windows or Linux. Published
x64 runtimes support Node 22.19+ on the Node 22 line, and Node 24. Install this
repository as a **personal Pi package**:

```sh
pi install git:github.com/gunba/pi-plugins
```

Restart Pi to load its new commands. Run `/desk setup`, then `/desk signin` with
your workspace's HTTPS address. `/desk open` starts the host and opens that
workspace. Sign into the same Microsoft account on each computer and browser.
See [remote access](RELAY.md) if the shared services are not deployed yet.

## Setup

`/desk setup` downloads and verifies a published runtime. It does not compile
Desk, change the global Pi CLI, or require a build toolchain. Desk pins its own
Pi SDK. The first download includes native dependencies; later code-only updates
reuse their verified download.

Choose the existing Desk data directory when migrating, or keep the default
`<Pi agent directory>/desk`. Account configuration, protected credentials and
native sessions remain in place. If saved login-start settings exist, setup
keeps their options and selected environment values. Otherwise, native dialogs
let you choose the default project, port, session directory and proxy.

The default port is 8910; zero selects an available loopback port. Leaving the
session directory empty uses native Pi settings/environment. Leaving the proxy
empty uses the normal proxy environment. The Pi agent directory comes from the
current Pi installation, including `PI_CODING_AGENT_DIR` if set.

Native bindings are built and checked before publication. Linux still requires
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

Open **Settings & tools → Computers**, expand a connected computer and choose
**Update now**. Confirmation selects that computer and captures the published
version or prepared runtime. Desk prepares verified code before replacing the
host; a changed published version needs a new selection. No maintenance
conversation, service reinstall or administrator access is needed.

Desk checks for updates at startup and every six hours, using a local cache.
**Check for updates** refreshes availability; detection alone installs nothing.
`/desk update` retains the quieter path: download while conversations continue,
then apply automatically when no Pi workers remain, including idle workers.

From 0.5.24, the confirmed website update holds new host admissions briefly,
saves the catalog and input ledger, and replaces only the HTTP/relay host through
the stable launcher. Independent workers keep their SDK sessions, tools, managed
processes, native queues, children and unanswered questions. The new host attaches
to those same authenticated actors. Accepted input outcomes are recovered by
receipt, not by resending text. No additional `Continue` is sent; idle work stays
idle. Other computers keep running.

Workers retain the immutable SDK/plugin runtime in which they started. New
conversations use the selected release. Conversation Settings distinguishes host
and worker versions; restart an individual conversation when its work is safely
checkpointed to load the newer worker. Reloading resources alone does not replace
its SDK. Runtime selection keeps older slots for live actors and rollback.

Hosts through 0.5.23 still own non-reconnectable workers. Their first move to
0.5.24 requires one coordinated native checkpoint and restoration through the
old controller. Queued opaque context, pending input or unsafe child scopes can
refuse that migration rather than lose data. After migration, native work does
not need to become idle for a host-only update. Host-owned sign-in/Dot operations
and failed catalog saves still need to finish before cutover. Failed or
unconfirmed outcomes need attention, not replay.
Ordinary **Close** still removes a conversation from the workspace while keeping
its native history. Native `/desk restart` and rollback remain explicit lifecycle
operations; they do not opt into the website's continuation checkpoint.

The browser shows preparation, waiting, application and failure states. A failed
download leaves the running release intact. The updater never cleans or
reinstalls the Pi package that another terminal process may be using. Website
publication is separate from native host updates.

| Command | Effect |
| --- | --- |
| `/desk` | Open the native management menu |
| `/desk status` | Show host, active/staged versions and latest operation outcome |
| `/desk stage` | Build the installed source explicitly for development; does not activate it |
| `/desk update` | Download a verified release and apply it automatically when no Pi workers remain |
| `/desk restart` | Confirm interruption of running sessions, select the staged version and start the host |
| `/desk rollback` | Confirm interruption and select the previous prepared runtime |
| `/desk stop` | Stop the host and its workers; keep native history |
| `/desk login` | Inspect, install or remove login-start |

These are native extension commands in both Pi and Desk. Restart and login
changes run outside their initiating conversation, so stopping that worker does
not cancel the operation. Reconnect and use `/desk status` to check its outcome.
Admission is not completion. Failed or unconfirmed operations are not retried.

Ordinary Pi startup does not build or fetch Desk updates. Native Pi package
management remains responsible for terminal extensions and third-party packages.
Prebuilt Desk delivery supports the unpinned public repository; local, pinned
and forked sources use explicit source preparation instead.

Each prepared version has its own first-party source, SDK, dependencies and
build output. Running workers and late child loads retain that version when Pi
updates the installed source. Third-party packages still use native discovery;
this isolation does not freeze their updates.

Development staging does not activate a release. To use that local build,
finish work or explicitly accept its interruption, then run `/desk restart`.
Questions, tools, children and automatic plans count as live work even when the
main conversation is idle.
Open sessions remain listed as interrupted after restart; resume or close them
explicitly. No restart replays
unfinished prompts or controls. Check receipts/history before repeating
uncertain work.

Routine updates use the Node executable saved for the managed host, not a
different Node used by terminal Pi. An unsupported platform/ABI is refused
before stopping a host. To deliberately change the saved Node path or run an
unpublished development build, use `/desk stage` and `/desk restart` with that
Node. This explicit operation may rebuild native dependencies and retarget
login-start; routine releases do neither. Prepared versions remain available
for rollback.

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

Version 0.5.31 retains API 8 and pins Pi 1.1.0. New workers load the maintained
Claude subscription extension and first-party command guard. Settings separates
tool declarations from callable tools and shows computer/project defaults and
conversation choices. Pi's Codemode and tool-search defaults are opt-in; use
`defaultTools: ["+codemode", "+tool_search"]` to add them without replacing the
native defaults. Preserve deliberate conversation selections.

The Settings/Resources browser and flat party sidebar require the matching
website; native resource controllers and tool metadata need a new worker.
Disband removes memberships without closing conversations. Existing workers
keep their SDK, plugins, protection and accepted work during a host-only update.
Replace an old guard only after the new worker's protection has been verified;
see [command protection](../pi-command-guard/README.md).

Version 0.5.30 retains API 8. Model overrides no longer invalidate Codex Wire
ownership or child compaction when Pi refreshes provider metadata. Affected
conversations need an individual worker restart after the host update; their
saved context limits, accounts and histories remain in place.

Version 0.5.29 retains API 8. The browser shows new operational notices in a
single temporary status bar rather than replaying saved warning cards. Existing
native records remain unchanged. The binary-export correction in child extension
loading requires a newly started worker; a host-only update does not replace
running conversations.

Version 0.5.26 retains API 8. Updated hosts and the website can attach to older
workers without restarting them. The model picker identifies older workers and
keeps cross-provider switching unavailable until an individual idle restart;
new conversations use the new Claude and context-handoff behavior. Host sign-in,
party close-all and browser layout fixes do not require restarting conversations.

Version 0.5.24 retains API 8; optional worker capabilities are advertised, so
older connected computers can continue working with the updated website. Send
now, availability and the full native command inventory require a supporting
worker; their absence is not a claim that its loaded runtime was upgraded.

Version 0.5.21 uses API 8: Dot connection commands select a saved account, and
message/upload commands carry a connection binding. Coordinate hosts, shared
services and the website when moving from API 7; an older client must not send
queued Dot work without that binding. Existing histories and delivery receipts
remain in place. Select the Dot's saved ChatGPT login after the update; this does
not change agent accounts or defaults.

Versions 0.5.18–0.5.20 use API 7: display sessions carry presentation data
once in `ui`, not a second copy in `snapshot.ui`. Moving from an older API requires
updating hosts, the website and shared services together. API 7 components can be
updated independently; optional Dot avatar and writing data require a 0.5.19 host,
and nested skill-read labels require a 0.5.20 host. Version 0.5.15–0.5.17 uses API 6; versions 0.5.9 and
0.5.10 use API 5. These releases use first-party presentation version 2. Deploy matching
website, account and broker artifacts before treating the cutover as complete.
Older computers may temporarily show **Update required**. A version mismatch
is not a reason to delete sessions, credentials or drafts.

Keep the website origin to retain browser storage. If it changes, export drafts
and files first. Do not copy `login.json`, signing keys or protected caches
between computers. Initial migration still requires local access to stop/update
an unmanaged host. A pre-0.5 managed host needs one final source preparation/
restart to acquire the release updater; subsequent updates use the website
or `/desk update`.

Computers running API 4 or earlier need a paused-work bootstrap to acquire the
API 5 checkpoint controller. Prepare the verified release while work continues,
then pause work and restart through the installed stable launcher. Do not send
the new Update now request to an older controller. Once API 5 is active, the
website can checkpoint running work during subsequent updates.

The scheduled-message extension and its commands are retired. Before replacing
older workers, finish or cancel pending reminders through their existing controls.
Saved messages and scheduler database files are not deleted.

## Recovery and rollback

On Windows, metadata replacement and verified runtime publication retry bounded
access/busy failures without deleting the destination or changing permissions.
A persistent preparation failure leaves the active runtime unchanged; use its
verified download cache when retrying preparation, rather than reinstalling the
service. Check status before retrying an unconfirmed activation.

A failed background catalog save does not stop the host. The machine shows
**Session save delayed** and offers **Retry saving**. Native histories are
separate from this catalog. Leave Desk running until its references are saved;
explicit update checkpoints still refuse an unsuccessful durability barrier.

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

From 0.5.28, newly launched workers retain their latest initialization, uncaught
exception or native fatal-error diagnostic in `workers/<conversation>/failure.json`
under the Desk data directory. Node reports exclude environment variables and
network interfaces, but can include error text and local paths. They do not
contain a heap dump. Existing workers keep their original launch settings;
missing diagnostics do not establish why an older worker stopped. Forced OS
termination may leave no report.

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
