# Pi capabilities

Desk loads the owning computer's Pi resources. Tools, settings, provider
credentials and plugin state stay there. The browser presents their results
and controls; it does not run a second agent or copy plugin stores.

## Core controls

| Capability | In Desk |
| --- | --- |
| New, saved and running conversations | Sidebar and **Resume conversation**: choose computer and project, then search a virtualized native catalogue |
| Model and reasoning | Compact searchable model picker with provider icons and account details; native reasoning levels and a per-computer default star. Cross-provider switches confirm context handling; encrypted Codex context requires an explicit summary handoff. |
| Provider accounts | **Settings → Model accounts**; native sign-in including Codex device codes and Claude subscription copy-code OAuth, per-computer defaults, conversation account choices and cancellation |
| Prompt, steer, follow-up and stop | Icon send control with a browser-saved Enter default and visible queue bars; **Send now** / Ctrl+Enter interrupts the current turn and admits the new message once, preserving accepted native queues. Stop dispatches pending steering into the next native turn. Older pinned workers show Send now as unavailable. |
| Name, pin, branch, fork, compact and reload | Inline title rename; other controls in conversation settings |
| Close worker | Header or sidebar close action with confirmation; saved native history remains |
| Questions | Native forms with a question chooser, drafts, deadlines and child attribution; mobile dialogs stay above the composer and within the keyboard viewport |
| Operator availability | **Settings → General → Availability**: Present or Away on the selected computer |
| Slash commands | The installed worker’s full Pi catalog plus registered extension/template/skill commands and browser handlers; parameters and qualified aliases retained, unbridged capabilities labelled |
| Resource failures | Startup banner and extension inventory; failed loads block prompts |
| Reconnect and uncertain delivery | Durable receipts and operation outcomes; no blind retries |
| Desk errors | One temporary, dismissible status bar with optional technical details; Pi/tool notices remain in the conversation |

The installed SDK supplies the built-in inventory; Desk does not maintain a
supported-command catalog. Browser handlers provide selectors and Settings,
while native adapters use public session/runtime interfaces. Native names keep
precedence over conflicting extensions; qualified extension aliases remain usable.
`/name` and `/rename` rename, `/clone` forks the current leaf, `/export` writes
HTML or JSONL, `/import` opens a JSONL import, and `/session`, `/copy` and
`/changelog` expose native reads. Export paths remain in durable control results.

Project-trust and scoped-model terminal selectors, GitHub sharing and native bug
reporting are not bridged. Their menu entries explain the gap rather than send
the command to a model. A newly discovered built-in with no adapter receives the
same explicit treatment. The inventory is read beside the pinned SDK’s immutable
entry because Pi 1.1 does not export its command catalog at the package root.
Desk loads the public SDK factories for Codemode, tool search and MCP. The CLI's
llama.cpp management extension is not exported through that SDK interface and is
not loaded in Desk.

## Unattended work

Availability defaults to **Present** and is saved per computer. **Away** makes
new optional agent questions return an unanswered result immediately, including
questions from subagents. It does not supply answers or grant permission.
Required confirmations stay pending. Existing questions are retained; forms
opened explicitly from Settings remain usable.

Availability is read by the worker, independently of browser visibility or host
attachment. Older workers without this capability need an individual idle
restart; Settings identifies them.

## Plugin paths

| Component | In Desk |
| --- | --- |
| `pi-desk` | Native `/desk` setup, update, restart, rollback, status and login-start dialogs; no separate browser management adapter |
| `pi-codex-wire` | Normal Codex transport and identity; Standard/Fast/Ultrafast speed, session settings, allowance and usage in Settings |
| `pi-message-timestamps` | Native message timestamps and saved tool durations; terminal activity clock remains in Pi |
| `pi-local-links` | Authenticated native file opening, folder reveal, previews and downloads, including links in older and child messages |
| `pi-codex-compat` | Managed process, image-inspection and image-generation tools; process state, output and images in chat |
| `pi-web-search` | Native search tool, readable results and Markdown citations |
| `pi-ask-user` | Choice, multi-select, free text, comments, editor, cancel and timed forms |
| `pi-config` | Searchable Settings/Resources browser: effective and saved values, native loaded-file inventory, protected previews and checked editing |
| `pi-system-context` | The worker's host/project context, not the browser's operating system |
| `pi-compaction-context` | Native compaction hooks; manual compaction in conversation settings |
| `pi-session-memory` | Native branch-aware memory/pruning hooks; no browser memory store |
| `pi-fast-footer` | Conversation footer with model/thinking/context and shared recorded usage; collapsed on mobile |
| `pi-context-ledger` | Expandable initial-context card and Settings controls; excluded from model context |
| `pi-context-window` | Capacity/automatic-compaction settings and native compaction controls |
| `pi-party` | Account-wide encrypted discovery and messaging; inline party labels, shared membership dialogs and Disband without stopping work. Owning-driver resume, approved creation and separate confirmed close-all report per-computer outcomes. Already-closed agents are skipped without waking their owner. |
| `pi-plan` | Visible objective/current-step summary; **Work → Plan** manages objective, steps and optional automatic continuation |
| `pi-subagents` | **Agents** shows active and queued work; **Previous agents** holds searchable, virtualized history. Full inactive panels open on demand without resuming work; launch settings remain under **Manage agents** and `/subagents` |
| `pi-output-budget` | Bounded previews and complete immutable artifact paging/search |
| `pi-work-ui` | Work navigation and section targeting; browser panels show each controller once rather than repeating terminal summaries |
| Browser skill / Chrome DevTools | Host Chrome tools and screenshots; Settings links to the installed extension's native dialogs |
| Native MCP / Gmail | Pi's tools and connection controls; native codemode and tool search run on the owning computer |
| `pi-tool-display` | Terminal decoration stays in Pi; Desk projects underlying results without running ANSI renderers |
| `pi-command-guard` | In-process shell/file risk screening, exact-call native confirmation and inherited child policy; not an OS sandbox |
| Local environment / other guards | Normal discovery and native context/tool-call hooks; installing Desk does not disable another guard |
| Skills, prompts and project resources | Native discovery, project trust and command expansion |
| Session ownership | Desk pre-open lease; shared terminal presence and shutdown integration |

## Dot

The Dot sidebar entry opens an existing ChatGPT Dot in the main conversation
area. **Connection** chooses a computer and a saved ChatGPT login independently
of agent accounts/defaults. Text chat, live updates, paged history, avatars and
supported attachments use a direct, account-pinned connection without Chrome.
An optimistic local outbox preserves drafts and sends in order. Changed accounts
hold earlier queued messages/files for review; uncertain sends are not replayed.

New Dot messages have a sidebar count, a tab-title alert and an in-conversation
jump button. Read markers are local to this browser and connection; messages are
acknowledged when the Dot conversation is visible at its latest messages. Initial
history is not treated as a new alert. The remote display pauses while the app is
hidden and catches up on return; these are not push notifications when Desk is
closed.

Dot's cloud execution and memory remain at OpenAI. Pi's Workspace is hidden
when viewing Dot. Native views expose ChatGPT's activity, profile, approvals and
cloud-computer controls through an owned Chrome tab opened only on request. Those
views require a separate browser sign-in to the same account. External sign-in
windows, browser permission dialogs, microphone capture and audio are not
forwarded. The private backend/web protocols can change; see the [Dot setup and
verification limits](README.md#dot).

## Account selection

A computer's account default applies when a new conversation is created. Existing
conversations retain their saved account. New subagents inherit their parent's
selection; existing subagents retain their own saved selection on recovery.
Changing a default does not sign in again or replace Pi's credential file.

## Display delivery

Each session carries presentation data once. A slow remote display pauses at its
acknowledgement limit and coalesces unsent replacement snapshots. Chat messages,
control transitions, inputs and questions retain their ordering; transport and
queue limits still apply. Display recovery does not replay agent work.

Browser storage and connection errors are not inserted into conversation history.
Repeated Desk errors share a temporary top status bar. A closed draft database is
reopened only if transaction creation failed before any read or write was admitted.

## Boundaries

- Custom terminal components are not converted to HTML. Plugins need a
  structured presentation or native UI dialogs. Unsupported custom UI reports
  a compatibility error rather than pretending the interaction succeeded.
- Secret configuration fields stay protected. Editing malformed sensitive
  files or changing protected connection fields requires a host-side editor.
  Native OAuth flows may also require the provider's browser setup on the host.
- Shared parties require computers enrolled under the same account and a running
  Desk connection. Local party operation remains independent. Remote inbox
  acceptance is not a reply; disconnected recipients and uncertain lifecycle
  outcomes are reported explicitly. Party channels cannot invoke browser APIs.
- Tool-title timestamp decoration is not patched into Pi's private TUI.
  The terminal keeps its live activity clock; Desk uses native timing metadata.
- Stop a terminal session before moving it to Desk. The terminal extension runs
  after Pi opens the file, so it cannot fence earlier migration/repair or an
  unmodified writer. See [session ownership](README.md#session-ownership).
- Resuming native history can deliver overdue reminders or restart queued child
  work. Automatic plans need their own Resume action. Child recovery is at least once,
  not an exactly-once guarantee for external effects.
- Live tools still require their normal credentials, installed dependencies and
  host permissions. Desk does not bypass network or workplace restrictions.

Linux SDK, terminal and browser checks cover the integration paths. Native
Windows, physical-phone installation and a public HTTPS deployment still need
their release checks. Browser emulation is not evidence for those platforms.
