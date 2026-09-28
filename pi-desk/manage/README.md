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

The login-start wrapper exits with the host. Selection waits for it, reuses the
saved launcher/Node and restarts without reinstalling the service/task. Idle
sessions still count as workers; interrupted references do not. Browser update
requests authorize only this fixed release operation, not shell commands or
client-supplied download URLs.

An explicit browser confirmation can instead request `apply-now`. It is bound
to the prepared runtime identity and rejected if that identity changes before
selection. This uses the same launcher path but allows graceful worker shutdown;
the workspace retains interrupted references for explicit Resume.

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
The launcher sets the host's code identity; workers receive it over private IPC
without inheriting the host's Desk environment.

## Selection and lifecycle

Staging and activation share the installation's `manage` lease. Configuration
and activation then acquire `login-edit`, `launch` and `host`, in that order.
Both the host and its login-start process must be stopped before selection.
An unresponsive process is not treated as permission to stop or replace it.

The server checks the selected identity **after acquiring the host lease**.
A launcher that loaded the old version just before activation therefore cannot
start that old host afterward. Active conversations are not an update boundary:
idle Pi sessions may still own questions, children, timers or automatic plans.

Native resource discovery sees the selected first-party snapshot. Actual
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

The release workflow accepts `pi-desk-v<version>` tags from commits with a
successful main CI run. Build jobs have read-only repository access. A separate
publisher uploads the complete Linux/Windows, Node 22/24 matrix and publishes it only
after every build succeeds. Bump Desk's version for changes shipped in its
runtime, including bundled first-party extensions.
Desk pull requests exercise the same package/install matrix without publishing.

Downloads are anchored to this repository's GitHub Releases API and its
[asset SHA-256 digests](https://docs.github.com/en/rest/releases/assets).
Metadata, code and dependencies must agree; no digest-less fallback is used.
This trusts the repository's release publisher and GitHub HTTPS, not an
independent code-signing key. Machine configuration, identity, credentials and
installation paths are not release metadata. GitHub proxy settings are read
without changing Git or the account configuration.
