# pi-show

Agents arrange results in Pi Desk's **Work** pane. The pane uses Desk's theme on desktop and phone. File changes remain in history; only selected operations appear in Work.

## Select useful tool results

`edit`, `write` and `bash` accept `show: boolean` beside their one-line `description`. Use `true` for something Jordan should inspect, `false` for routine work. The description becomes the activity title. These fields are presentation metadata, removed before execution; they do not change permissions or auditing.

```js
await tools.edit({path:"workers.ts", edits:[{oldText:"workers = 4",newText:"workers = 8"}],
  show:true, description:"Use the faster worker pool"});
```

Other operations—including `show`, agent management, plans, watches, search and questions—do not get the flag. They keep their own UI. The flag is documented in each relevant operation's discovered contract; discover `show` for the full show contract.

## Arrange results by stable ID

`show` accepts `id`, `title`, `spec`, `patch`, `items`, `note`, `source`, `before`, `pinned`, `collapsed` and `remove`. Reusing an ID updates that part; omit unchanged fields. A new call without an ID creates a part. Parts are scoped to their conversation. The return value is a compact receipt (`id`, `title`, `removed`, and item file/URL references), not another copy of the dashboard.

- `spec` is [json-render](https://json-render.dev/docs)'s `{root,elements,state?}` format, not HTML.
- `patch` is an atomic [RFC 6902 JSON Patch](https://json-render.dev/docs/streaming) array applied to the previous spec. Send `spec` or `patch`, not both.
- `pinned` keeps important parts above others. `before` places a part before another existing ID within its pin group.
- `collapsed` folds a part. `remove:true` removes it and stops its progress source, without erasing history.
- Updating or reordering an existing part does not steal selection or reopen a hidden pane.
- `note` is Markdown. `items` retains existing file/link previews.

```js
await tools.show({
  id:"results", title:"Batch comparison",
  spec:{root:"dashboard",elements:{
    dashboard:{type:"Column",props:{},children:["gain","table"]},
    gain:{type:"Metric",props:{label:"Throughput gain",value:"+14.5%",detail:"against baseline"}},
    table:{type:"Table",props:{columns:["Configuration","Jobs / minute"],
      rows:[["Candidate B",48.2],["Baseline",42.1]]}}
  }},
  items:[{file:"results.csv"}], description:"Show the comparison and its source data"
});
await tools.show({id:"results",pinned:true,
  patch:[{op:"replace",path:"/elements/gain/props/value",value:"+16.2%"}],
  description:"Keep the updated winner at the top"});
```

The catalog contains:

- `Column`, `Row`: `children` element IDs; `props:{}`. Rows adapt to available width.
- `Part`: `title`, optional `collapsed`, and children.
- `Text`: `text` (plain text).
- `Metric`: `label`, `value`, optional `detail`.
- `Progress`: `done`, `total`, optional `label`, `item`, `rate` (items/second), `eta` (seconds).
- `Table`: `columns` (strings), `rows` (arrays of scalar cells).
- `List`: `items` (strings).
- `Link`: `url`, optional `label`. Credential-free HTTP(S), opened separately.
- `Image`: `item` (zero-based attached item index), `alt`. `File`: `item`. These use Desk's existing file capabilities, not arbitrary filesystem or remote image URLs.
- `Code`: `text`, optional `language`. `Diff`: `before`, `after`.
- `Chart`: `spec`, an inline-data [Vega-Lite](https://vega.github.io/vega-lite/docs/) chart. Desk supplies sizing and theme. External data, expressions, transforms, image marks and hyperlinks are not supported. Aggregate/bin/time-unit encodings are available.

Props may read state using `{$state:"/path"}`. Specs cannot provide CSS, scripts or actions. Element IDs are stable keys; children form one reachable tree, without missing IDs, cycles or multiple parents. Patches may temporarily break the tree within one transaction, but the final result must be valid. Arrays, data depth, input size and component counts are bounded. Limits: 64 active parts, 256 elements/part, 128 patches/update, 16 progress sources, 500 table rows and 1,000 chart rows.

## Live progress without model turns

The process owns the output pipe. Register a file and either a literal pattern or existing JSON field names. Desk tails complete lines while the command runs and updates bound state; it does not call a model or run a script to interpret progress.

```js
await tools.show({
  id:"files",title:"Process the archive",pinned:true,
  source:{file:"progress.txt",pattern:"{done}/{total} {item}"},
  spec:{root:"progress",elements:{progress:{type:"Progress",props:{
    done:{$state:"/done"},total:{$state:"/total"},item:{$state:"/item"}
  }}}}, description:"Keep archive progress visible while processing"
});
// The ordinary job loop appends: printf '%s/%s %s\n' "$done" "$total" "$file" >> progress.txt
// PowerShell can append the same text to a Windows file. No progress library is needed.
```

Or map a process's JSONL fields:

```js
source:{file:"progress.jsonl",format:"jsonl",
  fields:{done:"processed",total:"count",item:"file",rate:"filesPerSecond",eta:"secondsLeft"}}
// Each line: {"processed":12,"count":340,"file":"report.pdf","filesPerSecond":4,"secondsLeft":82}
```

`done` and `total` are required nonnegative numbers. Optional fields are extracted literally; Desk does not guess a rate or ETA. Patterns support those five placeholders, separated by literal text, not arbitrary regexes. Each valid sample replaces the source's fields in the root state. Use `source:null` to stop watching without removing the result.

Reads are bounded and coalesced twice a second while the file changes. After two minutes without a change, polling slows to every ten seconds; after thirty minutes it stops. A later history load or re-show can restart an expired source. A valid `done >= total` sample closes the pipe immediately, and recorded completed parts do not start a pipe during replay. To run a completed part again, reset its counts when re-showing it and use a fresh or truncated progress file. Partial/invalid lines preserve the last valid sample; the pane distinguishes waiting, complete, invalid, stale and unavailable sources. File rotation/truncation is supported. Sources must be regular files; symlinks and special files are not accepted. Removing the part or closing its session disposes the watcher. Active worker reconnects retain current samples; worker restart replays the persisted spec and reopens its source file, so keep the file until the result no longer needs it. Full part snapshots are stored outside model context, including for nested codemode calls.

## Existing files and links

Up to 12 `items` can name `file`, `url` with optional `label`, a `focus` (sheet/range, line range or text), or described `changes`. Desk shows images inline, Office files as their contents, text as excerpts/diffs, and HTML in its existing sandbox without network or access to Desk. HTML remains an escape hatch for existing deliverables, not the default dashboard format.

For files changed during the conversation, Desk compares with the first observed version. Spreadsheet changes are cell-by-cell, documents paragraph-by-paragraph and slide decks slide-by-slide. Described spreadsheet changes are checked for unmentioned cells. No Office installation or Python runtime is required. First versions are kept for 30 days under `~/.pi/agent/show/<session>/`.

Links open separately and can be pinned in Work. They are never fetched by the show tool.

## Shared with Home

`pi-ui/agent-ui.ts` exposes server-safe `AgentSpec`, `validateSpec` and atomic `applySpecPatch`. `pi-ui/agent-catalog.ts` defines catalog composition/validation. `pi-desk/src/client/agent-ui/index.tsx` exports `AgentSurface`, `composeAgentCatalog` and the native json-render registry types.

Home contributes Canvas/Blob/Pill/Label/Connector components to the same catalog and uses the same specs and patches. The native component receives trusted `element.props.$id` for its map key; this is injected only at render time, not persisted or agent-authored. Home owns geometry/reference validation, revision checks, drag preferences and its local camera; Work owns its part placement metadata. No separate Home scene format or rendering engine is needed.

The runtime dependencies are json-render core/React with Zod. The chart chunk (Vega-Lite/Vega and the CSP-compatible expression interpreter) loads only when a chart is present. No Tailwind, shadcn, browser code generation, host runtime or service is required.
