# pi-clones — design

A primitive for **forking the running agent**, not spawning a stranger.

A *clone* is the current session, copied at a point in time, given one extra task,
run in the background, and re-merged into main when it finishes. It is the same
agent — same system prompt, same conversation, same tools, same auth — plus an
appended instruction. It is not a fresh "subagent" with zero context.

The name avoids the word *subagent* deliberately: that token carries swarm/team
baggage from pretraining and from the existing Pi plugins, all of which model a
separate persona that must be briefed from scratch. We are doing the opposite.

---

## 1. Why a clone beats a subagent (the conceptual answer)

The dominant subagent pattern (nicobailon, jwu, gee666, HamdiMaz) spawns a
**context-free** child and makes the parent re-describe everything in the task
string. That is where the overhead comes from: the parent burns tokens briefing
the child, the child reprocesses a cold prompt at full price, and a standing
skill/guideline block sits in the parent's context every session to teach it the
ritual. The "team of agents" framing is the source of the bloat, not an
incidental implementation detail.

A clone inverts every one of those costs:

| Concern | Subagent (context-free child) | Clone (forked session) |
|---|---|---|
| Briefing cost | Parent re-explains context in the prompt | Zero — clone already *has* the context |
| Cold-prompt cost | Child reprocesses everything at full price | Warm prefix → Anthropic cache **read** (~10%) |
| Auth | Child re-authenticates (OAuth re-load/race) | Shared in-process `modelRegistry` — no re-auth |
| Compatibility | Separate process / namespace drift | Same process, real `AgentSession`, full compaction |
| Standing context tax | Skill block every session | One tool, lazy advice on first use |
| Mental model | "brief a stranger" | "send a part of myself to go look" |

The clone's advantage is **contextual**, not just mechanical: it starts already
knowing what the main agent knows, so it makes better decisions on the delegated
task with no transfer loss. We already own the two mechanisms that make this
cheap to sustain — `pi-memedit` (context pruning) and `context-mode` (recall) —
so the clone does not need its own context-management apparatus.

---

## 2. Goals / non-goals

**Goals**
- Fork the live session into a background clone with one appended task.
- Inherit auth, model, tools, and full conversation verbatim.
- Re-merge the clone's result into main, with an alert on completion.
- Let the agent inspect a running clone (last activity + timestamp) and read its
  transcript if a result looks wrong.
- Keep clone sessions out of resume history.
- Maximise Anthropic prompt-cache reuse across the fork boundary.
- Keep the parent-context footprint to ~one tool + lazy, on-first-use advice.
- Be self-contained: correct even if every other pi-plugin is absent, and inert
  toward them when present.

**Non-goals**
- No personas, no "agent types", no role catalogue, no orchestration DSL.
- No standing skill/guideline block in every session.
- No worktree/memory/scheduling subsystems (tintinweb territory). Worktree
  isolation is an *opt-in escape hatch*, not a feature surface.

---

## 3. Architecture

Built entirely on confirmed `@earendil-works/pi-coding-agent@0.75.5` exports.

### 3.1 Execution model — Option A (preferred): in-process SDK fork

```
clone(task) tool call
  └─ fork the parent session into a hidden clones dir:
       SessionManager.fork(ctx.sessionManager.getSessionFile(), clonesDir, cwd)
       // full inherited history → new file under ~/.pi/agent/clones/…
       // (fallback: write getEntries() to a jsonl, then SessionManager.open())
  └─ capture parent's exact system-prompt bytes: ctx.getSystemPrompt()
  └─ createAgentSession({
       model: ctx.model, thinkingLevel,
       modelRegistry: ctx.modelRegistry,                 // SHARED auth (OAuth incl.)
       sessionManager: <the forked manager>,             // boots as a RESUME
       tools: <inherited allowlist minus blocking tools>,// see §10
       cwd: ctx.cwd,
     })                                                  // extensions load normally
  └─ pin clone system prompt = parent bytes (verbatim, no timestamp drift)
  └─ clone.prompt(task, { streamingBehavior: "followUp" })
  └─ subscribe to AgentSessionEvent stream (progress, completion, compaction)
```

Because the clone boots as a **resume** of the forked branch, the inherited
history is present when `session_start` fires. That is the property that makes
the full extension stack safe inside a clone (§10): `pi-memedit` seeds its
considered-set from the branch at `session_start` and freezes it as context-only,
so it only ever prunes the clone's *own* new work — never the inherited context.

Why in-process: shares the parent's model client and auth (no OAuth re-load or
refresh race), runs headless (`AgentSession` has no TTY dependency — the TUI is a
separate `InteractiveMode` wrapper), and gives the cleanest cache carryover
because the warm prefix lives in the same account within the same TTL window.

**Gate cleared (§12, spike-confirmed):** `createAgentSession` constructs headless
in ~16 ms with no TTY and no API call, and a second nested construct in the same
process succeeds in ~4 ms — the `discoverAndLoadExtensions` re-entrancy risk is
resolved. Option A is viable; Option B stays only as the write-isolation path.

### 3.2 Execution model — Option B (fallback): `RpcClient` subprocess

Seed a forked session file in a hidden dir, spawn `pi --mode rpc`, drive it via
the exported `RpcClient`. Full OS isolation; separate cwd possible. Costs: the
child re-authenticates, and byte-identical prefix is harder to guarantee across
processes (system-prompt timestamps differ), so cache hits are less reliable.
Use only if Option A's re-entrancy cannot be cleanly suppressed.

**Recommendation:** spike Option A; keep B as the isolation escape hatch and as
the implementation for explicitly *write-capable* clones that need a worktree.

---

## 4. Cache carryover (honest cost model)

Anthropic prompt caching is a **byte-exact prefix match, account-scoped**, ~10%
read price, 5-minute ephemeral TTL (1-hour available). It is *not* session-bound:
any request that reproduces a recently-sent prefix hits the cache.

A clone whose request renders as
`[identical tools] → [identical system bytes] → [identical history] → [new task]`
hits the parent's warm prefix up to the fork point. So the clone's **first turn**
costs:

```
≈ 0.10 × shared_prefix_tokens   (cache read of the inherited context)
+ 1.00 × task_tokens            (the appended instruction)
+ output
```

That is the real answer to "without paying a caching cost": you cannot make it
free — at minimum you pay the ~10% read on the shared prefix — but you avoid the
full-price reprocessing a context-free subagent incurs, **and** you avoid the
parent spending tokens to brief it. Net marginal cost of a clone ≪ a subagent.

To maximise hit rate the fork must preserve byte-identity:
- Replay `ctx.getSystemPrompt()` **verbatim** — do not let the clone rebuild it
  (otherwise `pi-system-context`'s timestamp shifts a byte in the prefix and
  invalidates everything after it).
- Pass tools in the **same order**; don't add/remove tools before the fork point.
- Fork **promptly** (within the TTL of the parent's last call).
- Place the cache breakpoint at the fork boundary; append the task as the final
  block. Enforce via the clone's `before_provider_request` hook.

If a hit is missed, the result is still correct — you just pay full input once.
Caching is an optimisation layer, never a correctness dependency.

---

## 5. Re-merge

When the clone reaches `agent_end` and is idle (no queued work), pi-clones:
1. Extracts the final assistant text (and, if requested, asks the clone for a
   short structured handoff before closing).
2. Injects it into the **parent** via `ExtensionActions.sendUserMessage`, wrapped
   as `<clone_result id=… task=…>…</clone_result>`, which steers a parent turn so
   the agent is alerted and can integrate immediately.
3. The tool description tells the agent these blocks are clone results, not user
   messages (same convention pi-lazy-skills uses for its advice block).

Silent variant: `appendEntry` records the result as a custom entry without
forcing a turn, for clones the agent said it would collect later.

---

## 6. Lazy advice (no standing context tax)

The `clone` tool ships with a **one-line** description. The full "how to author a
clone" guidance is injected **on first use per session**, reusing the
`pi-lazy-skills` mechanism exactly:

- Track an `advised` flag via a `custom_message` entry (`customType:
  "pi-clones-advice"`) so it survives resume and resets on compaction.
- On the first `clone` tool call in a session, attach the guide to that call's
  result (and as a displayed custom message), then proceed normally.

Guidance content (the "hey, you can clone yourself" note):

> You can create a **clone** — a copy of yourself with all of your current
> knowledge and context, plus one extra task you assign. Use it only for work
> that is genuinely parallelisable or independently researchable: investigations,
> wide reads, "go find out X while I keep going", independent verification.
> Give it one clear objective and a definition of done. It already knows
> everything you know — do not re-explain context; just state the new task.
> It will alert you when finished; you can also poll its status or read its log.
> A clone has no user to ask: if it hits a decision only the human can make, it
> records the blocker in its final report and stops — it escalates to you, never
> to the user.

---

## 7. Surface (tools + command)

Minimal, primitive-first. One tool the agent reaches for, four thin verbs around it.

| Tool | Purpose |
|---|---|
| `clone` | Fork self + task; returns `clone_id` immediately (background). Optional `{ tools: "read-only"\|"inherit", retention: "5m"\|"1h", collect: "auto"\|"manual" }`. |
| `clone_status` | `{id?}` → state (`running`/`idle`/`compacting`/`retrying`/`done`/`error`), **last entry text + timestamp**, tokens + context %, current tool activity. Lets the agent tell progress from stall. |
| `clone_result` | `{id}` → final response on demand (for `collect: "manual"` or re-fetch). |
| `clone_log` | `{id, tail?}` → browse the clone transcript when a result looks nonsensical. |
| `clone_stop` | `{id}` → abort a clone (and optional `clone_steer {id, msg}` if we want mid-run redirection; defer until needed). |

Command: `/clones` — TUI list of live/finished clones (token %, age, last
activity), with a renderer registered via `registerMessageRenderer` for the
`clone_result`/`clone-advice` custom types.

Status/liveness is built from the `AgentSession` event stream: `message_end`
stamps last-activity time + usage; `tool_execution_*` feeds current activity;
`getContextUsage()` feeds the percent.

---

## 8. Resume-hiding

Clone sessions live under a **non-default session directory**
(`~/.pi/agent/clones/<parentId>/<cloneId>.jsonl`). Pi's session pickers and
`pi-resume-search` enumerate via `SessionManager.listAll()` / `list(cwd,
sessionDir)`, which scan the default `~/.pi/agent/sessions/<encoded-cwd>/` root —
a sibling `clones/` dir is never listed. So clones are file-backed (giving
`clone_log` and the resume-as-fork seeding for free) yet structurally absent from
resume history. They are garbage-collected on a TTL; no tombstones in the tree.

---

## 9. Concurrency & file safety

In-process clones share the parent's cwd and OS process. The honest hazard is
write contention, so the default is shaped to avoid it:

- **Default clones are read-only** (`createReadOnlyTools` / allowlist:
  `read, grep, find, ls`, read-only `bash`). This matches the stated use case —
  research/investigate in parallel — and is race-free by construction.
- **Write-capable clones are opt-in** and routed through either the exported
  `withFileMutationQueue` (shared with the parent) or a git worktree via Option B
  (full isolation, changes re-merged as a branch). Never let two writers share a
  cwd unguarded.
- Many concurrent read clones are fine: each is an I/O-bound async loop awaiting
  the model API; they do not block each other meaningfully.

---

## 10. Clones run the full extension stack (and why that's safe)

A clone *is* the main agent, so it loads the same extensions — there is no
stripped-down "clone mode". Two confirmed properties make that safe, plus two
narrow carve-outs.

**Why memedit is safe in a clone.** `pi-memedit` seeds `consideredEntryIds` at
`session_start` from the existing branch — "a resumed conversation is frozen,
context only" — and `candidateScope` only ever marks entries the *live* session
produced. Because a clone boots as a resume of the inherited branch (§3.1), all
inherited context is frozen on entry; memedit can only prune the clone's own new
scratch, which is exactly what we want. No carve-out needed — your read was right.

**Why the rest is safe.** A clone is **headless** (`ctx.hasUI === false`), so
every `hasUI`-gated UI path no-ops automatically: memedit's pruning widget,
lazy-skills' notifications, usage's footer. They still do their non-UI work
(harmless, occasionally a little extra model cost), and `pi-usage` correctly
bills clone tokens against the unified Anthropic 5h/7d limit.

**Carve-out 1 — blocking tools (the AskUser hazard).** A background clone has no
attending human, so any *model-callable tool that awaits the user* is a trap.
`ask_user` in headless mode returns an `isError` "Ask requires interactive mode"
result (confirmed — it does not hang), but that invites confused retry loops. So
clones get a tool **allowlist that drops `ask_user`** (and login/confirmation
prompts), plus a clone-local stub that returns a plain instruction instead of an
error: *"No user attends a clone — record this as a blocker in your final report
and stop or proceed on your best judgment."* The clone-authoring guidance (§6)
states the rule directly: **clones escalate blockers to the parent; they never
ask the user.** The gate is "does it await the human", enforced by the headless
allowlist — no denylist treadmill.

**Carve-out 2 — recursion.** pi-clones loads inside the clone too, so a clone can
call `clone`. Bounded by a depth marker (custom entry `clone_depth`, default max
2) and a max-concurrent cap, mirroring the `PI_SUBAGENT_MAX_DEPTH` precedent.
Depth 0 = the human's session; a clone at max depth has `clone` removed from its
allowlist.

pi-clones never *assumes* memedit/context-mode/usage exist — it benefits from
them on the parent side and tolerates their absence — but it no longer fights
them inside clones.

---

## 11. Failure modes made impossible / handled

- Cache miss → still correct, full price once (never a hard failure).
- Clone overflow → real `AgentSession` compaction (`compaction_start/end`,
  `reason: "overflow"`); no bricking. This is the structural fix for the original
  "runs until token limit and bricks" complaint.
- Clone error/abort → surfaced via `clone_status` and a `<clone_result>` carrying
  the error; parent decides.
- Orphaned clones on parent shutdown → `session_shutdown` hook aborts all live
  clones and flushes any opt-in transcripts.

---

## 12. De-risking spikes

1. **Fork-resume seeds the branch — RESOLVED.** `SessionManager.forkFrom(parentFile,
   cwd, clonesDir)` carries the **full branch byte-identical** with **entry IDs
   preserved** (the memedit identity-freeze precondition) and leaves the parent
   untouched; the clone lands in a dir the normal session listing does not scan.
2. **Nested-extension sanity — RESOLVED.** Nested `createAgentSession` is stable:
   build #1 16 ms, build #2 4 ms, same process, headless (no TTY), no construct-time
   API call, `extensionsResult={extensions,errors,runtime}`. Depth/concurrency
   guards (§9) still own recursion. Driver API confirmed: `subscribe()`
   (multi-listener, returns unsub), `prompt(): Promise<void>`, `getSessionStats()`,
   `getContextUsage()`, `exportToJsonl()`, `setAutoCompactionEnabled()`,
   `compact()`, `dispose()`.
3. **Blocking-tool neutralisation — pending (P1).** Headless allowlist + `ask_user`
   stub; confirm no wait-on-human path survives in a clone.
4. **Cache proof — PRECONDITION MET, empirical check deferred (P2).** Inherited
   messages are byte-identical across the fork (proven), so the prefix *can* match.
   Confirm `cache_read_input_tokens` ≈ shared prefix on the first real clone turn.
5. **Re-merge turn — clone side RESOLVED, parent side pending (P1).** `subscribe`
   → `agent_end` gives the completion signal; confirm `sendUserMessage` from that
   async callback reliably steers a parent turn.

*Spike scripts:* `~/.pi/agent/tmp/clones-spike/` (`spike1-fork-resume.mjs`,
`spike2-createsession.mjs`) — all assertions green.

---

## 13. Phased implementation

- **P0 — fork + run + collect — DONE / live-verified.** `clone` (synchronous path)
  → `SessionManager.forkFrom` into hidden dir + depth meta → `createAgentSession`
  resume → `prompt` → `finalText` collect. Proven end-to-end in a real headless Pi
  (`CLONE_RESULT=PONG`).
- **P1 — background + re-merge + alert + inspection — DONE.** Non-blocking `clone`
  (default), `subscribe` progress stream, `sendMessage({triggerTurn,deliverAs})`
  re-merge, `clone_status` (last-activity timestamp), `clone_result`, `clone_log`,
  `clone_stop`, `/clones`, lazy first-use advice, depth + concurrency guards,
  `session_shutdown` cleanup. (Background alert suits interactive sessions; a `pi -p`
  parent may exit before a background clone finishes — use synchronous there.)
- **P2 — cache pinning — PRECONDITION MET, empirical check pending.** Byte-identical
  inherited prefix proven; optional `before_provider_request` breakpoint + verbatim
  system prompt to harden the hit rate, then verify `cache_read_input_tokens`.
- **P3 — polish — optional.** Custom `registerMessageRenderer` for `pi-clone-result`,
  transcript mirror for `clone_log` after `dispose`.
- **P4 — write clones — future.** Opt-in `withFileMutationQueue` / worktree (Option B).

*Implementation:* `pi-clones/extensions/clones.ts` (registered in the root
`package.json`). Validated: type-strip + import resolution; spikes 1–3 in
`~/.pi/agent/tmp/clones-spike/` (fork-seed, headless re-entrancy, depth/allowlist/
resume-hiding — all green); live synchronous round-trip under real Anthropic auth.

---

## 14. Package shape

```
pi-clones/
  extensions/clones.ts        # entry: registerTool(clone, …), pi.on(…)
  DESIGN.md                   # this file
```
Add to root `package.json` `pi.extensions`. Prefix `pi-`, MIT, peer-dep on
`@earendil-works/*` wildcards like the other plugins. Self-contained; no new
runtime deps.
```
```
