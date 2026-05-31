# pi-context-ledger

A TUI-only breakdown of everything Pi loaded *before* you started talking.

When you launch a Pi session you see startup rows (`[Context]`, `[Skills]`, …)
and then type your first message. Pi has many guards against context bloat
*during* a conversation (e.g. `pi-memedit`) but none for the context you pay for
on turn one. This extension fills that gap: right after your first message it
inserts a compact card summarising the initial context budget.

```
╭──────────────────────────────────────────────────────────────────╮
│ ◆ Initial context              ~48.3k tokens · 24% of 200k window  │
│ ────────────────────────────────────────────────────────────────  │
│ MCP tools        ███████████████████░  22.4k  46%  6 tools · ato…  │
│ Skills           ████████░░░░░░░░░░░░   5.6k  12%  21 skills        │
│ Project context  ██████░░░░░░░░░░░░░░   4.1k   8%  AGENTS.md        │
│ Extension tools  █████░░░░░░░░░░░░░░░░   3.3k   7%  12 tools         │
│ Core prompt      █████░░░░░░░░░░░░░░░░   3.2k   7%  base + guidelines│
│ Built-in tools   ████░░░░░░░░░░░░░░░░░   3.1k   6%  7 tools          │
│ Your message     █░░░░░░░░░░░░░░░░░░░░   0.8k   2%                   │
│ pre-conversation context · /context-ledger to recompute            │
╰──────────────────────────────────────────────────────────────────╯
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
and the largest consumer are colour-flagged so waste jumps out.

## Behaviour

- Shows **once per fresh session** (startup / new), immediately after your first
  message. Resumed and forked sessions are skipped.
- The card is **never sent to the model**. It renders in the TUI and persists in
  the session log, but a `context` hook strips it from every LLM call, so it
  costs zero context — it only reports it.
- Disabled automatically inside `pi-subagents` child processes.

## Controls

- `/context-ledger` — recompute and show the breakdown on demand.
- `/context-ledger off` / `/context-ledger on` — toggle the automatic card for
  the session.
- `PI_CONTEXT_LEDGER=off` — disable the automatic card at startup.
