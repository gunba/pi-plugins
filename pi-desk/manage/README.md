# Managed runtimes

The installed Pi package supplies source; each prepared runtime contains its
own first-party resources, locked dependencies and built Desk entry points.
Third-party packages continue to use native Pi discovery.

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
