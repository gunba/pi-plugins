# Pi capabilities

Desk loads the owning computer's Pi resources. Tools, settings, provider
credentials and plugin state stay there. The browser presents their results
and controls; it does not run a second agent or copy plugin stores.

## Core controls

| Capability | In Desk |
| --- | --- |
| New, saved and running conversations | Sidebar and **Resume conversation**: choose computer and project, then search a virtualized native catalogue |
| Model and reasoning | Composer selectors use the worker's native runtime; the star saves a default on that computer |
| Provider accounts | **Settings → Model accounts**; host-owned native sign-in, Codex device codes, a default for new conversations on each computer, conversation account choices and cancellation |
| Prompt, steer, follow-up and stop | Composer and visible queue bars; Stop dispatches pending steering into the next native turn |
| Name, pin, branch, fork, compact and reload | Inline title rename; other controls in conversation settings |
| Close worker | Header or sidebar close action with confirmation; saved native history remains |
| Questions | Native forms with a question chooser, drafts, deadlines and child attribution |
| Extension commands | Composer command completion; commands execute through Pi |
| Resource failures | Startup banner and extension inventory; failed loads block prompts |
| Reconnect and uncertain delivery | Durable receipts and operation outcomes; no blind retries |
| Desk errors | One temporary, dismissible status bar with optional technical details; Pi/tool notices remain in the conversation |

A registered extension command is not the same as a terminal built-in command.
Desk maps core controls through the public SDK. It does not send an unknown
terminal command to the model as a substitute.

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
| `pi-scheduler` | **Work → Scheduled** for create/cancel/details; native durable delivery and receipts |
| `pi-config` | Configuration panel: search, preview, setting reference, edit and checked save |
| `pi-system-context` | The worker's host/project context, not the browser's operating system |
| `pi-compaction-context` | Native compaction hooks; manual compaction in conversation settings |
| `pi-session-memory` | Native branch-aware memory/pruning hooks; no browser memory store |
| `pi-fast-footer` | Conversation footer with model/thinking/context and shared recorded usage; collapsed on mobile |
| `pi-context-ledger` | Expandable initial-context card and Settings controls; excluded from model context |
| `pi-context-window` | Capacity/automatic-compaction settings and native compaction controls |
| `pi-party` | Account-wide encrypted discovery and messaging; shared membership dialogs, owning-driver resume, approved creation and confirmed close-all with per-computer outcomes |
| `pi-plan` | Visible objective/current-step summary; **Work → Plan** manages objective, steps and optional automatic continuation |
| `pi-subagents` | **Agents** shows active and queued work; **Previous agents** holds searchable, virtualized history. Full inactive panels open on demand without resuming work; launch settings remain under **Manage agents** and `/subagents` |
| `pi-output-budget` | Bounded previews and complete immutable artifact paging/search |
| `pi-work-ui` | Work navigation and section targeting; browser panels show each controller once rather than repeating terminal summaries |
| Browser skill / Chrome DevTools | Host Chrome tools and screenshots; Settings links to the installed extension's native dialogs |
| Native MCP / Gmail | Pi's tools and connection controls; native codemode and tool search run on the owning computer |
| `pi-tool-display` | Terminal decoration stays in Pi; Desk projects underlying results without running ANSI renderers |
| Local environment / DCG guard | Normal discovery and native context/tool-call hooks, including inherited child policy |
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
