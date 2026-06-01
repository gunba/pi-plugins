# pi-context-ledger

A TUI-only breakdown of everything Pi loaded *before* you started talking.

When you launch a Pi session you see startup rows (`[Context]`, `[Skills]`, …)
and then type your first message. Pi has many guards against context bloat
*during* a conversation (e.g. `pi-memedit`) but none for the context you pay for
on turn one. This extension fills that gap: right after your first message it
inserts a compact card summarising the initial context budget.

Collapsed (default) — one bar per category, biggest-first, with a teaser of the
top contributor in each:

```
╭──────────────────────────────────────────────────────────────────╮
│ ▌ Initial context ▸             ~3.8k tokens · 24% of 200k window  │
│ ────────────────────────────────────────────────────────────────  │
│ Skills           ██████████████████████████  1.1k  29%  21 · ato… │
│ Project context  ████████████████████████░░   997  27%  AGENTS.md │
│ Extension tools  ██████████████░░░░░░░░░░░░   570  15%  5 · fetch… │
│ Core prompt      ██████████░░░░░░░░░░░░░░░░   436  12%  base + g…  │
│ MCP tools        ██████████░░░░░░░░░░░░░░░░   432  11%  2 · ato    │
│ Built-in tools   █████░░░░░░░░░░░░░░░░░░░░░   217   6%  7 tools    │
│ Your message     ░░░░░░░░░░░░░░░░░░░░░░░░░░    19   1%             │
│ ▸ ctrl+o to expand per-skill / per-tool detail                   │
╰──────────────────────────────────────────────────────────────────╯
```

Expanded (press the configured `app.tools.expand` key; `ctrl+o` by default) — every category opens into its
individual skills, tools, and files, sorted largest-first, so you can see
*exactly* which item is spending your context:

```
│ Skills             ██████████████████████████  1.1k   29%        │
│   ato-mcp-server   ██████████████████████████    54              │
│   context-mode     █████████████████████████░    53              │
│   daily            ████████████████████░░░░░░    41              │
│   gmail            ███████████████████░░░░░░░    39              │
│ MCP tools          ██████████░░░░░░░░░░░░░░░░   432   11%        │
│   ato              ██████████████████████████   258              │
│   mcp              ██████████████████░░░░░░░░   174              │
```

## What it measures

Three independently-measured buckets sum to the grand total, which is reconciled
against Pi's own `chars/4` token heuristic:

- **System prompt** — the assembled prompt string, decomposed into *Core prompt*
  (base instructions + guidelines), *Skills*, *Project context* (e.g. `AGENTS.md`),
  and *Appended prompt*. Skills/context/append are estimated from their source
  text; *Core prompt* absorbs the remainder so the rows stay additive against the
  measured whole.
- **Tool schemas** — the JSON schemas sent alongside the prompt, split into
  *MCP tools*, *Built-in tools*, and *Extension tools*. MCP schemas are usually
  the biggest avoidable cost.
- **Your message** — the first prompt text plus any attached images.

Rows are sorted largest-first and empty categories are hidden. The window-percent
and the largest consumer are colour-flagged so waste jumps out. Expanding the card
attributes every category down to every individual skill, tool, and file, so the
actual culprits are obvious.

Group bars scale to the grand total (cross-category magnitude); item bars scale to
their group's own largest contributor (so the per-group leader fills its bar).

## Behaviour

- Shows **once per fresh session** (startup / new), immediately after your first
  message. Resumed and forked sessions are skipped.
- **Collapsed by default; expandable in place.** It honours the same
  `app.tools.expand` key that expands tool output — collapsed shows categories,
  expanded shows every individual skill / tool / file.
- The card is **never sent to the model**. It renders in the TUI and persists in
  the session log, but a `context` hook strips it from every LLM call, so it
  costs zero context — it only reports it.
- Disabled automatically inside `pi-subagents` child processes.

## Controls

- `app.tools.expand` key (`ctrl+o` by default) — toggle category summary ↔ per-item breakdown.
- `/context-ledger` — recompute and show the breakdown on demand.
- `/context-ledger off` / `/context-ledger on` — toggle the automatic card for
  the session.
- `PI_CONTEXT_LEDGER=off` — disable the automatic card at startup.
