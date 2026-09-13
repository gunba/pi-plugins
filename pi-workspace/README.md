# Pi Workspace

A fullscreen terminal workspace with conversation on the left and files, changes
and extension work on the right. The right pane starts at 40% of the terminal;
drag its divider or use Alt+Left/Right to resize it. Each pane scrolls independently.

## Launch

Requires Node.js 22.19+ and Pi 0.85.1+. Run from the package checkout:

```sh
node pi-workspace/cli.mjs --cwd /path/to/project
```

To register the command in your npm executable directory:

```sh
npm link --omit=dev --ignore-scripts --legacy-peer-deps --workspaces=false
pi-workspace --cwd /path/to/project
```

The launcher resolves Pi's public SDK from the package installation, or the
global Pi installation when development dependencies are absent. It shares that
runtime with loaded extensions. No Pi files or `pi` launchers are replaced.

Options:

| Option | Behavior |
| --- | --- |
| `--cwd path` | Choose the workspace directory. |
| `--continue`, `-c` | Continue the latest session in that directory. |
| `--session file.jsonl` | Open a particular saved session. |
| `--no-session` | Use an in-memory session. |
| `--agent-dir path` | Choose a separate Pi configuration directory. |

Use one session selector at a time. Close a saved session in its other Pi frontend
before opening it here. Launching without a session selector creates a new session.

## Workspace

- **Work** collects extension widgets and statuses, including Goal, Todos,
  Subagents, Party and Scheduler. Click section headers or use Alt+1–4 to expand
  independent work sections. Ctrl+O continues to expand tool output in chat.
- **Files** browses directories and opens source files with syntax highlighting,
  line numbers, horizontal scrolling, search and go-to-line.
- **Changes** lists staged, unstaged, renamed, deleted and untracked files.
  A diff compares HEAD with the working tree, including staged changes. Old and
  new line numbers remain visible beside each hunk.
- File tabs retain their vertical scroll positions. The **⋯** menu lists all
  open views when the tab strip is full. Up to eight files remain open.
- Successful read and edit tools open their affected file automatically.
  **Following / Pinned** controls this behavior. The active file updates when it
  changes on disk. A pending extension prompt keeps its place until answered.

The reader handles text files up to 2 MiB. Large files use plain text above the
syntax-highlighting budget; binary files get an explicit explanation. Git and
file browsing are read-only. Diffs use literal Git arguments and never stage,
revert, checkout or modify files.

Below 80 columns, F6 switches between conversation and workspace. At wider sizes
it moves keyboard focus between the two panes. The editor draft survives pane
changes and resizing. Pane size and open tabs are local to this frontend run;
same-session extension reloads preserve file tabs and their scroll positions.

| Control | Action |
| --- | --- |
| F6 | Focus the other pane. |
| Alt+Left / Alt+Right | Resize the right pane between 25% and 60%. |
| Mouse wheel | Scroll the pane under the pointer. |
| Arrows, PageUp/Down, Home/End | Navigate the focused reader or Work pane. |
| `/`, `n`, `N` in reader | Search and move between matching lines. |
| `[`, `]` in reader | Previous / next diff hunk. |
| `g` in reader | Go to a source line. |
| Enter / Alt+Enter | Send or steer / enqueue a follow-up. |
| Escape | Return from a pane prompt or cancel the current Pi operation. |
| Ctrl+V | Paste text or attach a clipboard image. |
| Ctrl+L / Ctrl+P | Select / cycle the model. |
| Shift+Tab | Cycle supported reasoning efforts. |

The standard editor and extension shortcut names honor Pi's `keybindings.json`.
Workspace pane keys are reserved by this frontend.

## Commands

`/open path[:line]`, `/diff [path]`, `/files [directory]`, `/work`, `/panel [25–60]`,
`/find [text]`, `/line [number]`, `/attach path`, `/model`, `/thinking [level]`,
`/resume [session.jsonl]`, `/new`, `/tree`, `/fork`, `/import session.jsonl`,
`/compact [instructions]`, `/reload`, `/name text`, `/export [path]`, `/stats`,
`/help`, `/quit`.

Registered extension commands, skills and prompt templates are also available.
Unknown slash commands are rejected before inference. Pi's CLI-specific setup
commands such as `/login` and `/settings` remain available in the stock `pi`
frontend; this frontend uses the resulting configuration. The pane has its own
fixed palette, while Pi's native message renderers use the saved Pi theme.

## Extension interface

Existing `ctx.ui.setWidget()` content appears in Work. `setStatus()` appears there
as well; custom header/footer components retain their native locations. Selection,
input, editor and default `custom()` interactions appear inside the right pane.
Extensions explicitly requesting an overlay retain that behavior.

For a dedicated view, import the shared API from this package and acquire it at
`session_start`:

```ts
import { getWorkspace } from "../pi-workspace/api.ts";
import { Text } from "@earendil-works/pi-tui";

export default function extension(pi) {
  pi.on("session_start", (_event, ctx) => {
    const workspace = getWorkspace(pi);
    if (!workspace) return;
    const view = workspace.registerView("example/status", "Status", () =>
      new Text("Ready", 1, 1));
    view.show();
    // Later: view.refresh(), view.dispose(), or workspace.openFile(path, { line: 42 }).
  });
}
```

The discovery API and view handles expire when their session binding ends.
Replacement views retire their predecessors; stale handles cannot update or
remove the replacement. Component disposal runs on replacement, reload and
shutdown. Use a unique view ID and implement `dispose()` for owned resources.

## Runtime and validation

Pi's public SDK owns inference, tool execution, model and effort selection,
retry budgets, compaction hooks, cancellation, persisted sessions and extension
lifecycle. The frontend owns layout, focus, input and presentation. HTTP setup
uses Pi's configured proxy and idle timeout through Undici's public API.

The regression suite uses native Pi components, synthetic SDK sessions, a local
HTTP server and temporary Git repositories. It covers split sizing, independent
input/scrolling, draft preservation, lifecycle and leased views, prompt isolation,
streamed tool execution, complete extension loading and HTTP deadlines. It makes
no live model requests.

```sh
node --test --test-concurrency=4 pi-workspace/workspace.test.mjs pi-work-ui/tests/*.test.mjs
npm run typecheck
```
