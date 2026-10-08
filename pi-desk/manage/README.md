# Managed runtimes

Published releases supply each runtime's own first-party resources, locked
dependencies and built Desk entry points. The installed Pi package supplies
source only for explicit development preparation.
Third-party packages continue to use native Pi discovery.

The `/desk` extension registers a native command, not a model tool. Setup uses
native dialogs; preparation and updates run through a detached controller once
an installation exists. Pi's public package manager identifies the configured
personal source, but is not asked to update or clean it. Normal Pi startup
does not prepare runtimes.

`operation.json` records admission, progress and outcome under an OS-backed
operation lease. It is not a retry queue. Restart/stop/login changes run outside
the worker they close. An unfinished running record without a held lease is reported
as unconfirmed rather than replayed. `/desk status` distinguishes this operation
state from the running host and its active/pending versions.

`update` downloads a published release, records its exact identity in
`state.json.autoApply`, and attempts idle activation. With any live worker it
finishes in the deliberate `waiting` phase, releasing the controller process.
The host watches update records and worker exits; the existing heartbeat is a
fallback wake-up. An `apply` controller revalidates the request. It holds the
normal management/startup locks while the authenticated local control endpoint
atomically checks the worker count and closes admission. A new worker arriving
before that check defers activation.

Idle sessions still count as workers for automatic activation; interrupted
references do not. Browser update requests authorize only this fixed release
operation, not shell commands or client-supplied download URLs.

Explicit `apply-now` and `update-now` replace the host while independent actors
keep running. Application is bound to the verified prepared identity. A brief
admission hold commits actor identities and input receipts; the replacement
host adopts those same actors rather than restarting their native sessions.
Accepted messages, questions, tools and child processes remain with the actor.
An uncertain input is reconciled from its original receipt, never resent.

The lease-backed login supervisor stays alive across this host handoff and
starts the replacement through the saved stable launcher. Its owner, instance,
Node and entry must match the authenticated host and login configuration. A
verified live wrapper owns the transition; the OS manager's enabled state
controls future login launches, not this running wrapper. Without that verified
supervisor, selection still waits for the login-start process to stop. No
service or scheduled task is reinstalled during application.

Release detection runs at startup and every six hours, cached against the active
runtime identity in `release-check.json`. It checks public release metadata only,
never prepares or activates code. Network failures are shown separately from
host connectivity and do not stop work. Manual checks use the same bounded path.

`stageRuntime` publishes a ready version and changes only `state.json.pending`.
`configureRuntime` binds an installation to its existing host data directory.
`activateRuntime` selects a ready version and retains the previous identity.
Selection does not start a host, resume conversations or restore older data.

`launch.mjs` is a small, stable Node entry point. It selects versioned
`dist/host/managed.js`, which supplies the saved host defaults and invokes the
normal CLI. Login-start points to this launcher, not to a version directory.
The launcher sets the host's code identity. Each independent worker keeps its
own runtime pin and is attached through an authenticated loopback channel and
private registry, without inheriting the host's Desk process markers.

## Selection and lifecycle

Staging and activation share the installation's `manage` lease. Configuration
and activation then acquire `login-edit`, `launch` and `host`, in that order.
Configuration and direct selection require a stopped host and login-start
process. Explicit host handoff permits the verified supervisor to remain alive;
automatic idle application still waits for the manager to stop. An unresponsive
process is not treated as permission to stop or replace it.

The server checks the selected identity **after acquiring the host lease**.
A launcher that loaded the old version just before activation therefore cannot
start that old host afterward. Host replacement does not upgrade loaded actor
code: each actor retains its original Desk, plugin and Pi versions until its
individual restart. Conversation Settings reports these separately from the
host. Explicit conversation close still shuts down its native work.

Native resource discovery sees each actor's pinned first-party snapshot. Actual
settings persistence, resource filters and project trust remain native.
Parent tool-source metadata points to the snapshot, so late child-provider
loading does not depend on files surviving the next Pi package update.

Versions are not overwritten or automatically removed. A rollback selects
compatible code; it does not downgrade native histories, credentials or account
state. The initial migration from an unmanaged host must stop that host and
move its login-start entry before activating the managed installation.

The JavaScript-only management controller validates the ready release identity
and platform, but does not require its recorded Node ABI. This lets a new Node
prepare a replacement or stop the old host. Host/worker selection still requires
matching native dependencies. Restart/rollback validate their target before
closing a running host, then retarget stopped login-start to the current Node
and select the prepared version.

## Release artifacts

`node pi-desk/manage/pack-release.ts <output-directory>` builds an isolated
runtime from a clean committed checkout and verifies a second installation
without running npm there. The source package's native keyring module stays
loaded during that verification, exercising the Windows DLL-lock boundary.

Each platform/Node ABI has a manifest and separate code/dependency archives.
Dependency archives have content-addressed names and reproducible headers;
code-only releases can reuse the downloaded dependency archive. Installation
unpacks a fresh version, restores internal links, checks package/SDK versions
and runs isolated CLI/native-module smoke checks before publishing a pending
pointer. Preparation never cleans the configured Pi package or changes active
selection. Published payloads have identities distinct from source builds, so
the same-version bootstrap can switch to verified release code without replacing
an active directory.
Archives contain regular files only; links are validated relative runtime
paths, with Windows directory links restored as unprivileged junctions.

Release builds reuse a verified dependency bundle from the previous published
release when platform, architecture, Node ABI, dependency inputs and packaging
recipe match. The key ignores only the two first-party release versions, not
lockfile dependency entries or local dependency contents. A cache hit rebuilds
current code with the checkout's locked build tools, restores production-only
dependencies and reuses their original compressed archive. Archive integrity,
extraction limits, relocation and the full fresh consumer check still run.
A miss or invalid cache uses the normal locked installation. The cache index is
published only after verification. It uses release assets because GitHub's
Actions caches cannot be shared between different release tags; the first
release with this index seeds subsequent builds. Local packaging can opt in
with `PI_DESK_DEPENDENCY_CACHE=<directory>`.

The release workflow accepts `pi-desk-v<version>` tags from commits with a
successful main CI run. Build jobs have read-only repository access. A separate
publisher uploads the complete Linux/Windows, Node 22/24 matrix and publishes it only
after every build succeeds. Bump Desk's version for changes shipped in its
runtime, including bundled first-party extensions.
The native package/install matrix runs only for release tags. Main pushes run
Linux/Node 22 and Windows/Node 24 CI; manual `workflow_dispatch` runs all four
combinations. Feature pushes and pull requests do not trigger CI.

Downloads are anchored to this repository's GitHub Releases API and its
[asset SHA-256 digests](https://docs.github.com/en/rest/releases/assets).
Metadata, code and dependencies must agree; no digest-less fallback is used.
This trusts the repository's release publisher and GitHub HTTPS, not an
independent code-signing key. Machine configuration, identity, credentials and
installation paths are not release metadata. GitHub proxy settings are read
without changing Git or the account configuration.
