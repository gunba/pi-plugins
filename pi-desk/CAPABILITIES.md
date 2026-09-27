# Pi capabilities

Desk loads the owning computer's Pi resources. Tools, settings, provider
credentials and plugin state stay there. The browser presents their results
and controls; it does not run a second agent or copy plugin stores.

## Core controls

| Capability | In Desk |
| --- | --- |
| New, saved and running conversations | Sidebar and **Resume conversation**: choose computer and project, then search a virtualized native catalogue |
| Model and reasoning | Composer selectors; choices come from the worker's model runtime |
| Provider accounts | **Settings & tools → Providers**; native login methods and cancellation |
| Prompt, steer, follow-up and stop | Composer, queue controls and stop button |
| Name, pin, branch, fork, compact and reload | Conversation settings |
| Close worker | Conversation header; saved native history remains |
| Questions | Native forms with a question chooser, drafts, deadlines and child attribution |
| Extension commands | Composer command completion; commands execute through Pi |
| Resource failures | Startup banner and extension inventory; failed loads block prompts |
| Reconnect and uncertain delivery | Durable receipts and operation outcomes; no blind retries |

A registered extension command is not the same as a terminal built-in command.
Desk maps core controls through the public SDK. It does not send an unknown
terminal command to the model as a substitute.

## Plugin paths

| Component | In Desk |
| --- | --- |
| `pi-codex-wire` | Normal Codex transport and identity; Fast, session settings, allowance and usage in Settings |
| `pi-message-timestamps` | Native message timestamps and saved tool durations; terminal activity clock remains in Pi |
| `pi-local-links` | Authenticated host-file previews/downloads, including links in older and child messages |
| `pi-codex-compat` | Native patch, process, image-inspection and image-generation tools; diffs, process state, output and images in chat |
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
| `pi-party` | Settings and Work: discovery, membership, profiles, delivery, messages and paged history |
| `pi-plan` | Visible objective/current-step summary; **Work → Plan** manages objective, steps and optional automatic continuation |
| `pi-subagents` | Dedicated **Agents** pane for live transcripts, steering, follow-ups, Stop and scoped questions; `/subagents` manages launches/settings |
| `pi-output-budget` | Bounded previews and complete immutable artifact paging/search |
| `pi-work-ui` | Work navigation and section targeting; browser panels show each controller once rather than repeating terminal summaries |
| Browser skill / Chrome DevTools | Host Chrome tools and screenshots; Settings links to the installed extension's native dialogs |
| MCP adapter / Gmail | Existing tools plus connection status, refresh, enable/disable and sign-in/out controls |
| `pi-tool-display` | Terminal decoration stays in Pi; Desk projects underlying results without running ANSI renderers |
| Local environment / DCG guard | Normal discovery and native context/tool-call hooks, including inherited child policy |
| Skills, prompts and project resources | Native discovery, project trust and command expansion |
| Session ownership | Desk pre-open lease; shared terminal presence and shutdown integration |

## Boundaries

- Custom terminal components are not converted to HTML. Plugins need a
  structured presentation or native UI dialogs. Unsupported custom UI reports
  a compatibility error rather than pretending the interaction succeeded.
- Secret configuration fields stay protected. Editing malformed sensitive
  files or changing protected connection fields requires a host-side editor.
  Native OAuth flows may also require the provider's browser setup on the host.
- Party discovery remains local to each computer. The shared app does not turn
  Party into a cross-computer messaging service.
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
