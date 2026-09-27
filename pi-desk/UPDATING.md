# Installation and updates

Pi Desk requires Node 22.19 or later on Windows or Linux. Its package pins the
Pi SDK; updating the global Pi CLI does not replace Desk's engine. The host
loads the account's normal Pi configuration and extensions.

## Build and install

From `pi-desk/`:

```sh
npm ci --ignore-scripts
npm rebuild keytar
npm run typecheck
npm run build
npm pack --pack-destination /path/to/packages
```

Create the package destination outside the checkout first. Install the archive
into a user-owned application directory:

```sh
npm install --prefix /path/to/desk-app --omit=dev --ignore-scripts /path/to/packages/gunba-pi-desk-0.3.0.tgz
npm --prefix /path/to/desk-app rebuild keytar
node /path/to/desk-app/node_modules/@gunba/pi-desk/dist/host/cli.js doctor
```

`keytar` is a native dependency of Microsoft's protected-cache library.
`--ignore-scripts` alone leaves its binary unavailable; the targeted rebuild is
required on both platforms. An approved prebuilt binary normally avoids
compilation. If it cannot be downloaded, a supported native build toolchain is
needed. Linux also requires libsecret and an available, unlocked desktop Secret
Service. There is no fallback to plaintext token/key storage.

On Windows, no global package installation or PowerShell shim is required:

```powershell
$app = "$HOME\apps\desk-app"
npm install --prefix $app --omit=dev --ignore-scripts "$HOME\Downloads\gunba-pi-desk-0.3.0.tgz"
npm --prefix $app rebuild keytar
$desk = "$app\node_modules\@gunba\pi-desk\dist\host\cli.js"
node $desk signin --workspace https://desk.example.com --name "My computer"
node $desk start --cwd "C:\Projects"
node $desk open
node $desk doctor
```

Use a private user directory, not a shared/public folder. Sign-in uses the
current user's protected store. Organizational execution and network policy
still applies. Native binary or Secret Service installation may need IT help;
do not work around that by disabling protection.

A built checkout also works. Stop its hosts before rebuilding `dist/`.
See [remote deployment](RELAY.md) and [lifecycle commands](README.md#starting-and-stopping).

## Update an account-workspace release

1. Keep the previous package and record each host's directories/startup options.
   Preserve native sessions, the Pi agent directory, Desk data and the OS
   protected store. Neither credentials nor `login.json` are portable setup
   files for another computer.
2. Let work finish, or deliberately stop it. Use the existing executable's
   `stop` with the same `--data-dir`, then confirm `status` reports stopped.
   Login-start shutdown also waits for its launcher. Do not replace executable
   files while a worker can still load them.
3. Install the new archive, rebuild `keytar`, and run the new `doctor`.
   Keep the data/session directories in place.
4. Start with the same host options and approved environment. Check `doctor`
   and resource diagnostics before explicitly resuming saved sessions.
5. Reload browser tabs/app windows. Check native history and Recent operations
   before repeating uncertain work. No host restart automatically replays
   prompts, arbitrary tools or unfinished controls.

Login-start records absolute Node/app paths and selected environment values.
If these change, use the old executable's `login remove`, then reinstall with
the new executable and current host options. Do not copy another computer's
login configuration or protected cache.

Deploy matching account, broker and static builds to their separate services.
Preserve the authority directory and signing key. Generate the website with
`publish-app --account …`; runtime configuration is not an editable source
default. A broker restart disconnects clients but does not stop native workers.

## Moving to version 0.3

Version 0.3 uses API 3 and account credentials instead of remote invitations.
There is no translation layer or old remote-authentication mode.

1. Prepare the Microsoft registration, separate authority and private persistent
   storage using [Remote access](RELAY.md). Build and verify all release
   artifacts before replacing any live service.
2. Keep the website origin if possible so browser drafts remain available.
   If changing it, save drafts/files first; browser storage does not move with
   native conversations. Retain previous deployment/package artifacts.
3. When each PC is idle, remove its old login-start entry using its old
   executable, then stop it. Install 0.3 and rebuild `keytar`. Preserve native
   sessions and Desk data.
4. Enrol each PC with `signin --account https://account.example.com`. This
   works before the new website is published. Reinstall login-start using
   current host options, without old relay/app-origin arguments.
5. Replace the broker and website with the matching release. Configure the
   broker with `--account`, `--origin` and `--app-origin`. Remove the retired
   registration token from broker/PC environment and startup records.
6. Start PCs and sign into the website. Verify automatic directory discovery,
   real authentication and revocation from a fresh browser and the installed
   mobile app. Check both computers and the actual work-network connection.

The old remote grants are not imported: host access storage drops their secret
records, and the browser removes its old grant cache. Native conversations,
local recovery records and unsent drafts remain. A PC's new account ID can
change its browser draft key; **Settings → Saved drafts** provides explicit
text/file recovery without sending or overwriting another draft. Uncertain
deliveries still need confirmation before resend.

A rollout can temporarily leave an older computer unavailable. Keep each
computer's native sessions intact; neither a version mismatch nor re-enrolment
requires deleting them. Do not restore revoked remote grants to regain access.

## Rollback

For a compatible account-workspace release, stop hosts first and reinstall
the retained package with its matching service/browser artifacts. Preserve
account state and the signing key rather than restoring revoked enrolments.
Check that the older SDK can read native session files and installed extensions;
a package rollback is not a session-file downgrade.

Pre-0.3 packages cannot use account credentials. Do not roll the account
workspace back into obsolete remote pairing records. If a cutover fails, stop
the affected remote services and use trusted local recovery while fixing the
release. Remove login-start before installing an executable that cannot read
its configuration.

## Remove

Use `signout` while the authority is available, or remove the computer from a
trusted browser. Then `login remove` (if configured), `stop`, and confirm the
host is stopped before uninstalling only its application package:

```sh
npm uninstall --prefix /path/to/desk-app @gunba/pi-desk
```

Removing Desk does not require removing Pi or its plugins. Keep native sessions
and the agent directory. Submitted files under `desk/attachments/` can still be
referenced by saved conversations. Deleting them breaks those references.

Browser-app removal is separate. Sign out or revoke the browser first; clearing
site data alone is not account-wide revocation. It deletes local drafts, not
host conversations. Microsoft sign-in sessions are managed separately.

## Release checks

`doctor` reports installed/running app and SDK versions, built assets,
directories, login-start, host API and remote connectivity without printing
secrets. Errors return status 1; a deliberately stopped host is a warning.
It does not activate sessions, verify a Microsoft login or test model accounts.

Verify protected-store load/persistence on the target platform, not just
TypeScript compilation. CI's Windows DPAPI check does not establish workplace
approval, browser OAuth or proxy acceptance. Linux headless CI can check the
native binding without claiming it has an unlocked desktop keyring.

Application DTO changes that break compatibility increment `API_VERSION` in
`src/shared/release.ts`. Local JSON requests declare `X-Pi-Desk-API`, and local
event streams use `?api=`. Remote handshakes and authenticated messages bind the
API revision. Process management has its own record contract, so `stop` does
not depend on browser API compatibility. Never fix an update error by deleting
native sessions, credentials or drafts.
