# pi-show

Agents show Jordan results, progress and files in Pi Desk's **Work** pane, beside the conversation. Desk draws everything in its own theme, on a desktop or a phone.

## Which calls appear

`edit`, `write` and `bash` take `show: true | false` next to their `description`. With `true`, the call appears in Work, titled with the description; use it for what Jordan should look at, and `false` for routine work. Both fields are removed before the call runs, so they change nothing else.

```js
await tools.edit({path: "workers.ts", edits: [{oldText: "workers = 4", newText: "workers = 8"}],
  show: true, description: "Use the faster worker pool"});
```

Other operations (agents, plans, watches, search, questions and `show` itself) have no flag: they have their own place in Desk or nothing worth showing.

## Parts

Each `show` call adds or changes a part of the pane.

- **`id`** keeps a part in place. Show the same `id` again to change it, sending only the fields that change. A call without an `id` adds a part once.
- **`spec`** describes the part as data, not HTML (see below). **`patch`** changes the previous spec with [JSON Patch](https://json-render.dev/docs/streaming) operations, all applied together or not at all. Send one or the other.
- **`pinned`** keeps a part above unpinned ones; **`before`** puts it before another part; **`collapsed`** folds it; **`remove: true`** takes it away and stops its progress source. The conversation's history keeps everything.
- **`note`** is Markdown; **`items`** shows files and links (see below).
- Changing a part never moves Jordan's selection or reopens a pane he has closed.
- The call returns a short receipt, not the part again.

```js
await tools.show({
  id: "results", title: "Batch comparison",
  spec: {root: "dashboard", elements: {
    dashboard: {type: "Column", props: {}, children: ["gain", "table"]},
    gain: {type: "Metric", props: {label: "Throughput gain", value: "+14.5%", detail: "against baseline"}},
    table: {type: "Table", props: {columns: ["Configuration", "Jobs / minute"],
      rows: [["Candidate B", 48.2], ["Baseline", 42.1]]}}
  }},
  items: [{file: "results.csv"}], description: "Show the comparison and its data"
});
await tools.show({id: "results", pinned: true,
  patch: [{op: "replace", path: "/elements/gain/props/value", value: "+16.2%"}],
  description: "Keep the updated result at the top"});
```

### Specs

A spec is [json-render](https://json-render.dev/docs)'s `{root, elements, state?}`. Each element is `{type, props, children?}`; `children` lists other elements' names, and together they form one tree from `root`. Element types:

| Type | Props |
|---|---|
| `Column`, `Row` | none (`props: {}`); `children`. A row wraps when the pane is narrow. |
| `Part` | `title`, `collapsed?`; `children` |
| `Text` | `text` (plain) |
| `Metric` | `label`, `value`, `detail?` |
| `Progress` | `done`, `total`, `label?`, `item?`, `rate?` (items a second), `eta?` (seconds) |
| `Table` | `columns` (text), `rows` (lists of plain values) |
| `List` | `items` (text) |
| `Link` | `url` (http or https, without credentials), `label?` |
| `Image` | `item` (index into `items`, from 0), `alt` |
| `File` | `item` |
| `Code` | `text`, `language?` |
| `Diff` | `before`, `after` |
| `Chart` | `spec`: a [Vega-Lite](https://vega.github.io/vega-lite/docs/) chart with its data inline. No external data, expressions, transforms, image marks or links; aggregate, bin and time-unit encodings work. Desk sets its size and colours. |

A prop can read the spec's state with `{$state: "/path"}`. Specs can't carry CSS, scripts or actions.

Limits: 64 parts, 256 elements a part, 128 patch operations a call, 16 progress sources, 500 table rows and 1,000 chart rows.

## Live progress

A job can drive a progress bar without any model calls. The agent that starts the job says which file to read and how to read it; the job only appends lines to that file, with no library.

```js
await tools.show({
  id: "files", title: "Process the archive", pinned: true,
  source: {file: "progress.txt", pattern: "{done}/{total} {item}"},
  spec: {root: "progress", elements: {progress: {type: "Progress", props: {
    done: {$state: "/done"}, total: {$state: "/total"}, item: {$state: "/item"}
  }}}}, description: "Show the archive's progress"
});
// The job's loop appends:   printf '%s/%s %s\n' "$done" "$total" "$file" >> progress.txt
// PowerShell can append the same lines.
```

For a job that already writes JSON lines, name its fields instead:

```js
source: {file: "progress.jsonl", format: "jsonl",
  fields: {done: "processed", total: "count", item: "file", rate: "filesPerSecond", eta: "secondsLeft"}}
// Each line: {"processed": 12, "count": 340, "file": "report.pdf", "filesPerSecond": 4, "secondsLeft": 82}
```

- A pattern uses the placeholders `{done}`, `{total}`, `{item}`, `{rate}` and `{eta}` with plain text between them; it is not a regular expression. `done` and `total` must be numbers of 0 or more. Desk doesn't work out a rate or time left that the job doesn't give.
- Each valid line sets `done`, `total`, `item`, `rate` and `eta` in the spec's state. A broken line leaves the last good values, and the part says the source is waiting, live, complete, invalid, stale or unavailable.
- Desk reads new lines up to twice a second while the file changes. After 2 minutes without a change it checks every 10 seconds, and after 30 minutes it stops; showing the part again, or reopening the conversation, starts it again. It stops for good once `done` reaches `total`. To rerun a finished job, show the part with its counts reset and a new or emptied file.
- The file must be a regular file, not a link. It may be truncated or replaced. Keep it until the part no longer needs it: after a restart, Desk reads it again.
- `source: null` stops reading but keeps the part.

## Files and links

`items` holds up to 12 entries: a `file`, or a `url` with an optional `label`, with an optional `focus` (a sheet range such as `Sheet1!A1:C9`, lines such as `40-80`, or text to start at) or described `changes`.

- Images show inline, Office files as their contents and text files as excerpts or diffs. HTML and SVG open in a sandbox with no network and no access to Desk; use it for existing HTML or SVG deliverables, not for dashboards.
- A file changed during the conversation is compared with its first version seen: spreadsheets cell by cell, documents paragraph by paragraph, slide decks slide by slide. Described spreadsheet changes are checked for cells they don't mention. No Office or Python is needed. First versions are kept for 30 days in `~/.pi/agent/show/<session>/`.
- Links open in their own tab and can be pinned. `show` never fetches them.

## Shared with Home

Home draws its canvas with the same specs, patches and components. `pi-ui/agent-ui.ts` validates specs and applies patches, `pi-ui/agent-catalog.ts` defines the components, and `pi-desk/src/client/agent-ui/index.tsx` renders them. Home adds its own canvas components to the same catalog.

The client uses json-render (core and React) with Zod. Vega-Lite loads only when a chart is shown.
