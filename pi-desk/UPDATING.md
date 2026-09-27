# Installation and updates

Pi Desk requires Node 22.19 or later. Its package includes a pinned Pi SDK;
updating the global Pi CLI does not replace Desk's engine. The host still loads
the account's normal Pi configuration and extensions.

## Install a built package

While Desk is in development, build an archive from `pi-desk/`:

```sh
npm ci --ignore-scripts
npm run build
npm pack --pack-destination /path/to/packages
```

Create the destination first, outside the checkout. Install the resulting
archive into a user-owned application directory:

```sh
npm install --prefix /path/to/desk-app --omit=dev --ignore-scripts /path/to/packages/gunba-pi-desk-0.2.0.tgz
node /path/to/desk-app/node_modules/@gunba/pi-desk/dist/host/cli.js doctor
```

On Windows, use the same commands with quoted Windows paths. For example:

```powershell
$app = "$HOME\apps\desk-app"
npm install --prefix $app --omit=dev --ignore-scripts "$HOME\Downloads\gunba-pi-desk-0.2.0.tgz"
$desk = "$app\node_modules\@gunba\pi-desk\dist\host\cli.js"
node $desk doctor
node $desk start --cwd "C:\Projects"
node $desk open --pair
```

The direct Node entry point avoids relying on a global installation or a shell
shim. See [starting and stopping](README.md#starting-and-stopping) and
[remote access](RELAY.md) for options. A built source checkout is also usable;
stop its hosts before rebuilding `dist/`.

## Update

1. Keep the previous archive and record each host's startup options. `status`
   reports its directories, origin and relay. Preserve the private environment
   used to launch it, including its relay token and command paths.
2. Let work finish, or deliberately stop it. Run `stop` using the existing
   executable and the same `--data-dir` for each affected host. Confirm `status`
   reports stopped. With login-start configured, `stop` also waits for its launcher.
   Do not replace files while an old worker can still load them.
3. Install the new archive into the same application directory. Keep the Pi
   agent directory, native session directories and Desk data directory unchanged.
   Run `doctor` from the new executable.
4. Start with the same directories, relay and environment. Check `doctor` and
   the app's resource diagnostics before resuming saved sessions.
5. Reload browser tabs or installed app windows. Resume conversations explicitly.
   No worker, interrupted prompt or arbitrary tool is automatically replayed by
   a host restart. Check native history and Recent operations before repeating
   uncertain work.

Login-start records absolute Node/app paths. An in-place app update keeps the
same integration and private environment. If either executable path changes,
run `login remove` with the old installation, then `login install` from the new
one with the required startup options and environment. Inspect `login status`
and `doctor`; do not copy `login.json` to another computer.

For remote access, publish the static app and standalone relay from the same
build to their separate services. Use `publish-app` to generate app configuration
and headers, as described in [remote access](RELAY.md). Restart the relay at the
same relay origin with the registration secret and `--app-origin`. Its `/health`
response includes version and app-origin information. A relay restart
disconnects browsers but does not stop PC workers.

### Moving from a combined server

Version 0.2 uses API 2 and requires separate app/relay origins. Prepare the new
static deployment first. Save unsent browser and attachment drafts before
changing app origins; browser storage does not move with native conversations.
Revoke the previous remote device grants using the trusted local app before
stopping and updating the idle connectors. Reinstall login-start with both
`--relay` and `--app-origin`. Stop the old relay before changing its startup
command and deploying the message-only release, then start it with the new app
origin. Create fresh browser invitations after both services are ready.

Update desktop shortcuts and phone bookmarks/installations to the new app address.
The old relay URL intentionally stops serving an app or redirecting invitations.
Do not copy browser keys from its storage to the new origin. Keep native
sessions and Desk host data in place.

### Compatible releases and rollback

The app/server and PCs can be updated one at a time. An incompatible computer is
unavailable until its API matches; other compatible computers remain usable.
There is no translation layer for old application APIs. An update error does
not revoke device keys or clear drafts. Do not forget/re-pair a computer to fix
a version error.

To roll back, stop first, reinstall the retained archive, and use its matching
relay/client files on their separate services. Releases before 0.2 do not support
this hosting boundary. Keep the same data directories. Check that the older SDK
can read the native session format and load the installed extensions; a package
rollback is not a session-file downgrade. Restore a pre-update backup if a
future release requires a data migration.
Remove login-start before rolling back to a release that does not provide its
entry point or understand its startup configuration.

## Remove

Stop each host and the relay you intend to remove. Run `pi-desk login remove`
for each configured instance before removing its executable. That command stops
the host and removes its owned startup entry without deleting other host data.
Confirm the host has stopped, then uninstall
only the app package:

```sh
npm uninstall --prefix /path/to/desk-app @gunba/pi-desk
```

For a source checkout, remove its optional app installation only after stopping
its hosts. Removing Desk does not require removing Pi or its plugins.

Keep native sessions and the Pi agent directory. Keep Desk's data directory if
you want its device grants, names, pins and operation outcomes on reinstall.
Files under the agent directory's `desk/attachments/` can be referenced by saved
native conversations; deleting those files breaks those references.

Removing an installed browser app is separate from removing the host. Clearing
that site's browser data loses its pairings, unsent drafts and attachment drafts.
It does not delete host conversations or revoke another device. Use Device
access on the host to revoke a device that should no longer have access.

## Release checks

`doctor` distinguishes the installed package from a running host. It reports
the app/API versions, actual SDK and expected SDK, runtime paths and startup
status without printing management or provider secrets. A wrong SDK requires
reinstalling that Desk release, not changing the global CLI.
The JSON `checks` list reports built app files, accessible directories,
login-start, host API and remote connectivity. Errors return exit status 1.
Warnings, such as a deliberately stopped host, do not fail the command. Doctor
does not activate a session or validate model-service credentials.

Startup rejects missing client files or entry scripts/styles rather than
advertising a healthy server that only returns a blank page. Keep the complete
distribution together; deleting an asset from a running server still requires
restoring it and restarting the server.

Application DTO/command changes that break compatibility must increment
`API_VERSION` in `src/shared/release.ts`. JSON requests declare it through
`X-Pi-Desk-API`; local event streams use `?api=`. Remote peers check it before
pairing and in authenticated messages. Process management has its own runtime
record contract, so `stop` does not depend on browser API compatibility.
