# Pi Desk

See [Pi capabilities](CAPABILITIES.md) for plugin controls and integration limits.
Read [Security](SECURITY.md) before enabling remote access. An authorized browser can
run Pi tools with the host account's permissions; this is not a read-only viewer
or a sandbox.

A desktop and mobile client for Pi. The local host runs Pi's normal SDK and
extensions in session workers; browser connections do not own agent lifetimes.

The shared website supports conversations, streaming, tool output, model
controls, questions and Work summaries. Sign into the same Microsoft-owned
workspace on each computer and browser; enrolled computers appear automatically.
An encrypted outbound connection provides remote access without inbound PC
ports or a VPN. Saved-session resume, branch navigation,
forks, compaction, configuration, Party, plan/scheduler and child-agent
controls are connected. The conversation footer shows model/thinking, context,
recorded usage and first-party Fast/allowance badges, with expanded settings
panels. Initial-context breakdowns, model accounts, MCP
connections and Chrome management are connected. Live tool output, patch diffs,
attachments, paged artifacts and host file previews/downloads are available.
The shared app combines sessions from several computers, with independent
connection states and account-wide access controls. Parties share encrypted
discovery, membership and messages across those computers; their sidebar groups
open shared membership controls and a confirmed close-all action. Unsent drafts stay in their
browser. An unavailable computer does not
block the others.
The included `/desk` command handles setup, staged updates, restart and optional
login-start using native Pi dialogs. Prepared runtimes pin the first-party
resources; updating the installed source does not replace live worker code.
Foreground/detached entry points remain available for development and recovery.
This is not an independently audited remote-access
product. See [installation and updates](UPDATING.md) for setup and platform checks.

## Getting started

Install this repository as a personal Pi package, restart Pi, and run
`/desk setup`. Then `/desk signin` connects this computer to the shared workspace
and `/desk open` opens it. Use `/desk` for management; see
[installation and updates](UPDATING.md) for migration and platform prerequisites.

## Development

Requires Node 22.19 or later. Native account storage also needs the protected-cache
dependency and the platform facilities described in [installation](UPDATING.md).

```sh
npm install --ignore-scripts
npm rebuild keytar
npm run typecheck
npm run build
node dist/host/cli.js doctor
node dist/host/cli.js inspect /path/to/project
node dist/host/cli.js serve --cwd /path/to/project
```

`inspect` loads the normal installed Pi resources into an ephemeral session,
reports extensions, tools and commands, then shuts down. It does not request
model inference. Run it against a trusted project to include project resources.

`serve` listens on `127.0.0.1:8910`. Use `open --local` for a local recovery link.
Use `--port` to select another port and `--data-dir` for isolated development
state. This command runs in the foreground; `start` detaches instead.

For shared desktop/phone access, sign in with `signin --workspace URL` on each
host. See [remote access](RELAY.md). The app groups sessions
by computer and routes controls to their owner; no per-computer app switch is
required. Desk owns SDK sessions, not live terminal displays. An existing terminal
session must release its writer before Desk can resume it.

Stop development hosts before rebuilding their executable output. For a
client-only build, use `npx vite build --outDir dist/client`; Vite's default
output directory would replace the host build as well.

**Resume conversation** opens a searchable picker. Choose a computer, then its
current project, another folder or all projects. Settings provides branch,
fork, compaction, name and pin controls. **Close** is in the conversation header,
including during startup. Its confirmation identifies the worker and outstanding
work. Closing stops that worker and removes the session from the workspace;
its native history remains available in **Resume conversation**. The sidebar
lists open sessions, including interrupted sessions awaiting an explicit Resume,
not every previously opened conversation. Native Pi
messages still queued for delivery are discarded; unresolved host admissions
remain available for review. A host restart restores
session references and marks interrupted sessions; it does not replay browser
prompts. An interrupted session can be resumed or closed; its composer is unavailable
until Pi starts again. A new wake-requesting message from a current party member
can resume an interrupted open workspace member through its owning session or
parent driver. Explicitly closed conversations are not reopened by automatic
peer delivery.

**Project folder** opens the same folder browser in New conversation and Resume.
It browses the selected computer, with breadcrumbs, parent/home navigation,
name filtering, hidden-folder controls and optional direct path entry. Recent
projects come from native session headers, cached Pi metadata and Desk references,
without loading transcripts or starting Pi. Locations include home, the default
project and local Windows drives or the Linux filesystem root. Drive discovery
runs separately so a slow Windows query does not block folders or projects.
Folder rows are paged; only the selected computer is queried.

Closing or suspending a browser does not stop a worker: questions, children,
timers and goal continuation remain with the owning computer. Stop the session
or host to stop its active work.

Computer labels describe this browser's link: Connecting, Connected,
Reconnecting or App paused. A hidden tab disconnects intentionally; returning
re-establishes the authenticated channel. This is not a report that the PC
stopped. Settings shows the separate last host heartbeat and unexpected
connection interruptions (time and close code, not message contents). A stale
directory report cannot enable commands or extend an authorization lease.

Explicitly resuming a saved session also loads its native plugin state:

- Overdue scheduled messages can be delivered immediately.
- Queued child work and unfinished child deliveries can run again. The
  subagents plugin uses at-least-once recovery; inspect history after a crash
  before resuming work with external effects.
- Restored goals are disarmed and need their own **Resume** action.

Stopping does not delete pending child inbox entries or scheduled messages.
Desk retains unresolved browser input for review, but does not replay it or
unfinished controls after a worker or host restart.
Shutdown cancels native work and questions, then joins pending startup,
transitions and native cleanup before releasing the writer;
overlapping stop requests wait for the same cleanup.

The composer uses native model and thinking selectors. Its star action saves the
selected model as this computer's default; ordinary selections only change the
current session. The footer shows context and the same recorded-usage reducer
as the first-party terminal footer. Unreported context or usage stays
unknown. Usage includes recorded child charges once; cost is not a subscription
bill. Structured view badges expose the owning plugin's settings without parsing
terminal strings: Fast is a preference, not a guarantee that the provider used
priority processing, and allowance is passively reported rather than polled.
The mobile footer starts collapsed; expand it for usage, status and settings.

The picker searches title/opening-text previews and host paths, not complete
conversation text. Named-only filtering and recent-first ordering follow Pi's
session metadata. Rows are virtualized; bounded pages load as you scroll. Only
the selected computer and scope are queried. Refresh rechecks files; changed
results invalidate older page positions rather than mixing catalogue versions.

The host uses Pi's public `SessionManager.list`/`listAll` APIs in an isolated
listing thread, with progress and cancellation. The first response returns
cached results immediately, including while a cold scan is still running.
Recent completed scans are reused. At most two listing threads run per host,
each with a 512 MiB JavaScript heap budget; failures leave cached previews
available and ask you to narrow the project selection.

A private, rebuildable metadata index (`history.sqlite` in the data directory)
stores bounded previews, not complete messages or another authoritative
conversation record. Discovery includes the configured session store and
directories used by Desk's saved session references. Browsing does not start
agent sessions or load extensions. Indexing failures are shown in the picker.
Pi skips unreadable records and files. A completed listing replaces that scope's
cached membership; an interrupted or failed listing retains its cached previews.
With the host stopped, deleting this index and its SQLite sidecars only forces
a rebuild; it does not delete native sessions.

### Starting and stopping

For a managed installation, use `/desk` or its stable launcher from
[installation and updates](UPDATING.md). The commands below describe the direct
development/standalone CLI. From a built checkout, use `node dist/host/cli.js`
in place of `pi-desk`:

```sh
pi-desk signin --workspace https://desk.example.com --name "My computer"
pi-desk start --cwd /path/to/project
pi-desk open
pi-desk status
pi-desk stop
```

`signin` reuses saved authorization or opens Microsoft sign-in, then saves this
computer's workspace. It does not force the account picker unless a different
account was selected. `open`
starts the host if needed and opens the shared website, where each browser signs
in independently. `--local` instead creates a short-lived loopback recovery
link; it is not part of routine onboarding. `--print` displays the URL rather
than launching a browser. Keep local recovery links private.

`start` creates a detached Node process with redirected input/output, not a
terminal session or system service. It uses the same Node executable and
inherits the launching environment, including tool paths and Pi configuration.
A repeated start reuses the running host; its startup options are not changed.
Stop before changing those options. Pass `--data-dir` consistently when managing
an alternate instance. Its working directory, agent directory, session directory
and relay settings are reported by `status`, not inferred from the new shell.

On Windows, the direct Node entry point also avoids depending on a PowerShell
command shim:

```powershell
$desk = "$HOME\apps\pi-desk\dist\host\cli.js"
node $desk start --cwd "C:\Projects"
node $desk open
node $desk status
node $desk stop
```

These are user processes. No service registration, firewall rule or elevation
is required. Native Pi retains its configured command shell. Organizational
execution/network policy still applies. Login-start integration is separate;
the computer must remain awake and the account logged in.

`stop` asks the authenticated local host to shut down its workers and waits for
their process exits. It does not kill a saved PID, replay interrupted work or
delete native history. Long shutdowns report that they are still in progress;
no automatic force-kill occurs. A later start restores saved references without
automatically starting workers.

The private data directory contains `host.json`, an incarnation-specific
runtime record, and `host.log`. The record includes a temporary control secret
and is removed after shutdown; it is not a portable configuration file.
Persistent browser/provider credentials are not used for process management.
Management routes are loopback-only and are not forwarded through the relay.
The log rotates to `host.log.1` on startup when it exceeds 8 MiB.

`doctor` reports the app/API versions, Node executable/version, platform,
installed and pinned SDK, selected directories and running host version/status.
Its JSON `checks` include the built app files, directory access, host API,
optional login-start and outbound relay state. Exit status 1 means a check
failed. An offline/connecting relay fails the remote-access check even when the
local host is healthy; `status` remains useful for checking the local process.
A stopped host is a warning, not a broken installation.

Doctor does not start workers, load project extensions, send model requests or
test provider credentials. Use the app's resource inventory after explicitly
starting a session. It does not print runtime secrets or saved environment
values. A malformed runtime record produces a generic recovery message, not a
JSON excerpt.

Native host startup rejects an incomplete app distribution. Build the app,
native host, account service and broker together, then deploy their separate
artifacts. An occupied lock with no responding management
endpoint is reported as unavailable rather than treated as permission to kill
a process. An older foreground host must be stopped before upgrading.

Stop hosts before replacing their installed executable files. Keep native
session files, the Pi agent directory and the Desk data directory when changing
or removing the app package. See the [update and removal guide](UPDATING.md).

The app and each computer negotiate one application API revision, independently
of encrypted transport framing. Incompatible clients cannot admit session
commands or consume a local recovery invitation. That computer shows **Update required**;
the other computers remain usable. A server mismatch opens an update screen,
not another sign-in requirement. Reload after updating; enrolments, drafts and uncertain
delivery receipts remain on the device. Settings shows app/host versions.

### Start at login

Stop the host, then configure the optional integration using its usual startup
options:

```sh
pi-desk stop
pi-desk login install --cwd /path/to/project
pi-desk login status
pi-desk start
```

The host reads its saved account configuration; no registration secret or
relay argument is needed. Use the same `--data-dir` on every command
when selecting a non-default instance. Installing enables future login-start
without starting the host immediately. `start` and `open` then use that service
or task; `stop` waits for its host and launcher to finish.

Linux uses a `systemd --user` service. Windows uses a current-user logon task,
an interactive limited token and a hidden PowerShell launcher. It does not
store a Windows password or request elevation. The account must be logged in,
and the PC awake. No wake timer, linger setting or system-wide power setting is
changed. If policy prevents registration, ordinary `start`/`serve` are still
available after a failed installation has been cleaned up.

The private `login.json` records the Node/app paths, host options and selected
environment values. Defaults include PATH, locale, proxy/certificate variables,
the session-directory override and a small set of Pi process
settings. It does not copy the entire shell environment or current Pi session
markers or account-service configuration/signing secrets. Ordinary provider authentication still comes from the Pi agent
directory and inherited OS environment.

For another required variable, name it explicitly:

```sh
pi-desk login install --cwd /path/to/project --env OPENAI_API_KEY
```

This saves its current value privately; it is not a reference that refreshes
from future shells. Prefer Pi's existing credential store when appropriate.
Status reports saved variable **names**, not values. Keep `login.json` private
and do not copy it between computers.

To change startup options, Node/app paths or captured values, remove and
reinstall the integration:

```sh
pi-desk login remove
```

Removal stops that host, disables/unregisters its owned service/task, and removes
only the private startup configuration. Native sessions, provider credentials,
Desk account/local recovery records and referenced attachments remain. The installer refuses
to overwrite or delete a foreign service/task with the same name.

Startup failures appear in `doctor`, service/task status, `host.log` and, when
available, `login-error.txt`. There is no automatic crash-restart loop and no
forced process-tree termination. A subsequent start restores references, not
active workers or tool requests.

Managed users can instead use `/desk login`; its detached controller performs
the stop/change/start sequence after confirmation. It does not apply an unrelated
staged update or resume conversations.

The user-service flow is exercised on Linux. Native Windows registration,
window behavior and shutdown still require the platform check. The Windows
implementation uses the documented [task principal](https://learn.microsoft.com/en-us/powershell/module/scheduledtasks/new-scheduledtaskprincipal)
and [task settings](https://learn.microsoft.com/en-us/powershell/module/scheduledtasks/new-scheduledtasksettingsset)
APIs. Linux shutdown uses [systemd's process and signal controls](https://man7.org/linux/man-pages/man5/systemd.kill.5.html).

### Session content

The conversation's **Agents** bar opens a dedicated pane beside the chat on a
wide screen, or a full-height sheet on a phone. It offers live state/activity,
a searchable virtualized agent list, and the selected agent's paged transcript:
assistant text/thinking, tool cards, images and complete-output links. Finished
agents remain available through **Include finished**. A new active collection
can open the desktop pane when no other panel or text editor is in use.

Pending steering and follow-ups remain visible above the composer. **Stop**
interrupts the current reply and starts the next native turn when steering is
waiting; it does not invent another prompt when that queue is empty.

**Steer** updates a running direct child; **Queue** accepts a native follow-up.
An idle continuable child offers **Send** to wake it. The owning subagent runtime
enforces direct-parent messaging and ancestor interruption, just as the terminal
tools do. Stop targets that agent's current work, not every descendant; queued
tasks remain saved. `/subagents` manages launches and model permissions, and
`/subagents <id>` opens that agent's pane. The terminal dashboard is unchanged.

Drafts are separate for each agent on this browser. Inline sends wait for native
controller admission. Uncertain replies retain the draft and exact request ID:
**Check delivery** asks for that same result, not another message. A new send
requires confirmation; reconnect never sends automatically. Each view has its
own action lock, so a launch dialog does not block another agent's controls.

Chat and detail views render GitHub-flavoured Markdown tables. Transcript errors
appear at their recorded time rather than accumulating in a global banner.

History uses the already-owned Pi managers, not filesystem paths supplied by
the browser or another conversation store. Earlier pages stay bounded; Latest returns
to live output. Parent and child streams use separate channels.
Individual inline assets currently have a 16 MiB limit and a bounded worker
cache. Oversized-output handling is still being expanded; the interface marks
previews that cannot offer the complete asset. Native output artifacts are
read separately and do not have this inline-asset limit.
Artifact searches use the shared streaming store; large sources and matching
lines do not need to fit in a worker's JavaScript heap.

Expired asset, file and artifact references are rebuilt from their original
message on the host. Requests include the parent or child transcript identity;
they never supply a replacement filesystem path. Recovery keeps cache limits
and file-version checks intact.

The browser shares concurrent requests for the same output and limits inline
asset transfers to two at a time. Images outside the reading area release their
blobs while keeping their layout space. Repeated output opens and file downloads
reuse their loaded data; leaving their conversation or viewer releases it.
Failed image loads have a retry control.

Initial-context cards project their existing native entries and stay out of
model context. Only explicit display projections reach the browser; generic SDK
event notifications carry event names, not private extension records or provider
checkpoint data. Rich controls can call registered extension commands through
Pi's normal interactive command path. Child scopes cannot dispatch a parent's
commands.

### Dialogs and navigation

Dialogs keep keyboard focus inside and return it when closed. Escape and browser
Back dismiss the top surface; nested questions do not also close their underlying
panel. Back from a detailed settings or Work view returns to its parent panel.
Desktop inspectors leave the conversation usable beside them; narrow windows
use modal sheets.

Closing a question with Back, Escape or its close button only hides it. Pi keeps
waiting, and **Answer** reopens it with the draft intact. **Cancel** explicitly
cancels the request. Questions identify their computer and conversation; input
errors appear inside the form. Draft answers stay in memory and are scoped to
their conversation and question.

Type `/` in the composer to discover loaded extension commands, templates and
skills. Arrow keys select a match, Tab completes it and Escape hides the list.
Desk also provides `/settings [section]`, `/new [directory]`, `/resume`,
`/name [name]`, `/compact [instructions]` and `/reload`. A loaded native command
with the same name keeps precedence. `/name` opens the inline title editor.
Literal file paths remain messages, not commands.

### Opening context

The context icon beside conversation settings, or Settings → Opening context,
opens a lazy inspector of Pi’s system prompt, instruction files, skills and
native tool loadout. Choices are stored on the native session branch and applied
by Desk’s SDK resource loader; they survive resume and forks. They do not delete
installed resources or remove content already read into history. A terminal
resume uses that terminal’s configured resource loader.

Tool selection controls native declarations, not permissions. Codemode and
deferred catalogs may still call undeclared tools. Their availability is shown
separately. The prompt-size estimate uses characters / 4, including direct tool
schemas; it is not a provider token measurement.

Instruction files have a separate editor. Saving changes the loaded file on its
computer, with a version check against concurrent disk changes. Managed runtime
files are read-only. Other sessions pick up file changes on resource reload;
conversation-only exclusions do not change the files.

Changing the selected model, reasoning, opening context, Fast mode or context
budget stops an active turn, applies the change, and sends Continue once.
Native queued messages and images stay in the same session. Idle conversations
stay idle; setting the default only changes preferences for new conversations.
Pending questions, sign-in and compaction must finish first. This interrupt
behavior is declared by owned setting actions, not imposed on third-party actions.

Registered slash commands acknowledge dispatch without waiting for interactive
input to finish. Questions and command execution remain owned by the host.

Close-session, remove-computer and uncertain-delivery decisions use the same
dialogs, with an explicit target and Cancel/Back behavior. A conversation change
cancels an open decision. Dismissing an uncertain resend keeps its receipt and
draft; a new delivery requires an explicit choice.

Plugin actions acknowledge admission without keeping a request open while you
answer a form. Their views show pending work and disable repeated actions, even
when the plugin updates its display or the browser reconnects. Execution failures
appear in the originating view and Activity. Admission is not completion, and
the app does not replay an action after a worker restart.

Compaction, branch changes, forks, resource reloads, model changes, stop and close
also acknowledge admission separately from completion. Progress stays on the
host; **Settings → Recent operations** shows the latest 16 outcomes. Duplicate
receipts do not start another operation in the same worker. Failed or interrupted
operations are not retried automatically. After a lost connection, check this
history and the native conversation before repeating a control.

Close is bound to the worker activation, not a not-yet-created or changing
presentation generation. It uses private parent/worker lifecycle IPC and waits
for process exit, so a startup close cannot be mistaken for a stale UI command.

Unfinished operations become unconfirmed after a worker or host failure. Only
small control-operation metadata is saved. Pending message admission is separate
and retains unresolved input for review. A failed worker cannot leave a live
question in the browser.

Pi editor suggestions, including **Fork & edit**, appear as an offered draft.
**Use draft** fills this device's composer; replacing existing unsent text needs
confirmation. A plugin or another device cannot silently replace that draft.

### Tools and captured output

Tool arguments and progress update while Pi runs. Partial tool output is limited
to its latest 4,000 characters, updated at most ten times per second per tool.
Tools without progress callbacks still show their running state. Native saved
results replace temporary progress cards. Process handles and exit codes come
from the tool result; a process reported as running is labelled as a snapshot,
not presented as still running forever.

Patch results show file-level additions, removals and changes, with copy controls
and links for longer diffs. Previews show up to 32 changed files and 400 lines /
12,000 characters per diff. Larger change lists have a complete-details link
within the inline-asset limit. Code blocks also have copy controls.

Complete-output links open a paged viewer backed by `pi-output-budget`'s existing
immutable artifact store. Next/previous, character offsets, case-sensitive line
search and page copying work locally and through the encrypted relay. Offsets
count UTF-16 characters, matching the native `read_artifact` tool. Only artifacts
observed in that worker's transcript projection can be opened; opening an old
message refreshes its reference. Reconnect does not download artifact bodies.
Native integrity checks and maintenance ownership remain in the output plugin.

### Reading conversations

Root and child transcripts use bounded native pages with Older, Newer and
Latest controls. A measured viewport renders nearby messages rather than the
whole history. Scrolling away from live output keeps that reading window in
place while new work arrives. Sending a prompt returns the root view to Latest.

The browser saves reading anchors and measured row sizes, not conversation
contents, for up to 64 views. Root positions survive switching conversations,
reloads and reconnections. If a saved position is absent from the active branch,
the view returns to Latest. Child handles belong to their owning activation;
reopening a replaced child source starts a fresh view.

Pages contain up to 40 saved messages with a serialized-size budget, plus current
live state. Recent caches retain at most 80 messages per source and use a shared
count/size budget across conversations. Long-message previews share a
32,000-character allowance, including up to 8,000 characters of thinking;
complete text remains available separately when it fits the asset limit.
Streamed text beyond that preview is not repeatedly transmitted.

Viewport measurement uses [TanStack Virtual](https://tanstack.com/virtual/latest/docs/api/virtualizer),
pinned and bundled into the client. It is not a host or terminal dependency.

### Files

Markdown file links, local images, patch paths and supported tool path fields
open in the associated application on the file's computer. The link's tooltip
names that destination. Hover or keyboard-focus a link to reveal its folder,
download a copy here, or open Preview. On phones, the primary action downloads
here. Relative paths use that conversation's native working
directory, including child conversations. Encoded filenames, file URLs and
`#L123` line references are supported. Submitted attachments show their original
names. These are display projections; native messages and model input do not
change.

Preview resolves the link on its host and shows the actual path, size and type.
UTF-8 text uses 32,000-byte pages with line navigation and copying. PNG, JPEG,
GIF and WebP previews are limited to 16 MiB; selecting an image opens its full
size. Preview displays HTML, SVG and scripts as text, never executed in Desk. Other
binary files, including PDFs, can be downloaded or opened by their host's
associated application. Executable formats and launcher files are not launched
from Desk.

Downloads use checked, bounded chunks over the same authenticated local or
encrypted remote connection. The browser assembles at most 128 MiB per file.
Cancel or close the viewer to stop a transfer. If the live file changes, refresh
before continuing; pages from different observed file versions are not combined.
Line navigation scans at most the first 128 MiB.

The browser supplies an observed file reference, not an arbitrary path. File
contents are not read just because a message is displayed. Direct network/UNC
and device path addresses are rejected; symbolic links resolve when opened.
This is not a workspace sandbox: normal host-user permissions and mounted
volumes still apply. References have a bounded worker cache; reopen their
message after a reference expires.

### Attachments and drafts

Attach files with the composer button, paste files/images, or drop them onto
the composer. Limits are eight files per message, 8 MiB per file and 32 MiB
combined. Draft files stay in this browser's IndexedDB until sent or removed;
message text stays in local storage. They survive a page reload, but unsent
drafts are not shared between devices.

**Settings → Saved drafts** lists drafts whose conversation is no longer
available in the current workspace. Copy text and attachments to an empty
selected conversation, or download files directly. Originals remain, upload
handles are reset and uncertain delivery still requires confirmation. Copying
a draft sends nothing.

Sending uploads the files in bounded, retryable chunks. Remote uploads use
the encrypted relay channel. Files receive private, generated host paths under
the Pi agent directory's `desk/attachments/`; original names cannot select a
destination or overwrite workspace files. PNG, JPEG, GIF and WebP contents
are passed to Pi's native image-input API when the selected model supports
images. Other files, and images with a text-only model, are supplied as host
file references for Pi's tools.

Keep submitted files with their native session history. The host retains
them rather than deleting files an accepted or queued prompt may still need.
Each conversation can store up to 128 MiB or 256 attachments. Unsubmitted
uploads older than a day are removed when that conversation starts another
upload. Clearing browser data deletes unsent drafts, not host files.

You can send text and files while Pi is still starting. The host saves admission
to `inputs.sqlite` before acknowledging it. **Pending messages** shows Waiting
for Pi, Confirming admission, or a failure. Cancel works before dispatch; once
dispatch begins, check the conversation rather than treating a disconnect as
cancellation. Up to 16 unresolved messages can be retained per conversation.

On a keyboard, Enter sends or steers current work. Alt+Enter or Ctrl+Q queues a
follow-up; Shift+Enter or Ctrl+J inserts a new line. Shift/Alt-clicking Send also
queues a follow-up. While busy, separate **Steer** and **Queue** buttons work on
touchscreens; the phone keyboard keeps ordinary Enter for new lines. IME
composition does not submit. **In Pi** shows native steering/follow-up counts
and up to twelve bounded previews per queue, distinct from host admissions.

Input is bound to that worker activation and native generation. It cannot drift
into another branch or a restarted worker. Startup messages use native follow-up
delivery in submission order. Uploaded files use a stable conversation scope;
only the host writes their metadata, and the native worker reads them.

The admission receipt survives reconnects and host restarts. Retrying unchanged
input reuses its receipt, including when Pi finished loading while the reply was
lost. Accepted payloads are removed from the admission store; native JSONL remains
conversation history. Failed or unconfirmed input retains its text and files.
**Review** lets you inspect, explicitly send again, or discard it. Startup failure
offers **Retry**; saved conversations instead offer **Resume**.
Restart never automatically sends retained input. Undispatched cancellations
release their file references for normal unused-upload cleanup.

### Accounts and connections

Model accounts lists the SDK's non-secret credential metadata and configured
sources. It is not a live credential check. OAuth sign-in, cancellation and
credential removal use `ModelRuntime`; device codes, authorization links and
callback prompts appear in the app. Access/refresh tokens stay on the host.
API keys, cloud credentials and OAuth flows requiring secret input remain host
setup operations through Pi. Other running sessions may need Reload resources
after changing an account.

MCP connections subscribes to the adapter's documented `status/v1` channel and
uses its registered commands for connection refresh, OAuth, enable/disable and
logout. A fully deferred adapter may publish no server inventory until Connect
initializes it. No additional MCP client or credential store is created.
Configuration uses the protected Configuration panel. The adapter's guided
terminal-only setup screens remain host setup operations. A stdio server with
its own credentials, such as a local Gmail wrapper, keeps that server's setup
procedure; the adapter's OAuth command applies to HTTP OAuth servers.

Chrome opens the installed native DevTools extension's RPC settings, tool
selection and diagnostics. It operates the host's browser. A phone does not
need Chrome remote debugging or access to the host's loopback port.

### Session ownership

Desk acquires a writer lease before opening a session. Install the repository's
`pi-session-ownership` integration before moving sessions between the app and CLI.
An explicit **Resume** stops active work in the participating desktop Pi session,
requests its normal shutdown, and waits for its writer lease to release. Desk then
opens the newly saved history, including desktop branch changes. Unrelated
sessions are not stopped, and automatic recovery does not request takeovers.
Existing terminals must reload the updated extension or be closed manually once.
Desk never force-kills a PID or removes a live lock.

The CLI opens files before the extension runs, so its guard cannot
prevent earlier legacy-file migration or metadata repair. Unmodified writers
do not participate in the lease. Desk does not patch Pi to hide this boundary.
Use `--session-dir` to select a session store; otherwise the normal environment
and Pi settings apply.

The SDK version is pinned in this package. Credentials and installed resources
come from the normal Pi agent directory, including `PI_CODING_AGENT_DIR` when
set. Do not copy credentials into the application.

## Structure

Remote access setup is in [RELAY.md](RELAY.md).

- `src/host/engine.ts`: Pi SDK and session lifecycle.
- `src/host/presentation.ts`: structured views and user interactions.
- `src/host/integrations.ts`: documented third-party status and command bridges.
- `src/host/transcript-feed.ts`: shared native message projection for roots and children.
- `src/host/worker.ts`: private process protocol and command receipts.
- `src/host/server.ts`: authenticated HTTP API and reconnectable event stream.
- `src/account/`: delegated-token validation, device directory and credentials.
- `src/host/account-identity.ts`: native sign-in and protected persistence.
- `src/host/publish-app.ts`: separate website configuration and headers.
- `src/host/relay-server.ts`: opaque routing and proof-of-key admission.
- `src/host/relay-connector.ts`: outbound connection and device authorization.
- `src/client/`: responsive conversation interface.
- `src/shared/protocol.ts`: serializable app messages.
- `src/shared/account-channel.ts`: credential-bound ephemeral handshakes.
- `../pi-ui/`: lightweight presentation discovery for extensions.
- `extensions/desk.ts`: native setup and management command.
- `manage/`: immutable source preparation and stable-launcher selection.

The app is an optional package. Its frontend and server dependencies are not
part of ordinary pi-plugins extension loading.
