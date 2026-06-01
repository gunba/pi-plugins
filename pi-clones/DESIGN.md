# pi-clones — design

A primitive for **forking the running agent**, not spawning a stranger.

A *clone* is the current session, copied at a point in time, given one extra task,
run in the background, and reported back to main when it finishes. It is the same
agent — same conversation, same auth/model, with tool access shaped by the
requested mode — plus an appended instruction. It is not a fresh "subagent" with
zero context.

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
- Inherit auth, model, and full conversation verbatim.
- Alert main on completion without dumping full clone context; full handoffs are fetched with `clone_result` when needed.
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

Built on confirmed `@earendil-works/pi-coding-agent` SDK exports.

### 3.1 Execution model — Option A (preferred): in-process SDK fork

```
clone(task) tool call
  └─ fork the parent session into a hidden clones dir:
       SessionManager.fork(ctx.sessionManager.getSessionFile(), clonesDir, cwd)
       // full inherited history → new file under ~/.pi/agent/clones/…
       // (fallback: write getEntries() to a jsonl, then SessionManager.open())
  └─ createAgentSession({
       model: ctx.model, thinkingLevel: pi.getThinkingLevel(),
       modelRegistry: ctx.modelRegistry,                 // SHARED auth (OAuth incl.)
       sessionManager: <the forked manager>,             // boots as a RESUME
       tools: <mode allowlist minus blocking tools>,     // see §10
       cwd: ctx.cwd,
     })                                                  // extensions load normally
  └─ clone.prompt(task)
  └─ subscribe to AgentSessionEvent stream (progress, completion, compaction)
```

Because the clone boots as a **resume** of the forked branch, the inherited
history is present when `session_start` fires. That is the property that makes
the full extension stack safe inside a clone (§10): `pi-memedit` seeds its
considered-set from the branch at `session_start` and freezes it as context-only,
so it only ever prunes the clone's *own* new work — never the inherited context.

Why in-process: shares the parent's model client and auth (no OAuth re-load or
refresh race), runs headless (`AgentSession` has no TTY dependency — the TUI is a
separate `InteractiveMode` wrapper), and gives the cleanest available cache carryover
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

A clone can hit the parent's warm prefix up to the fork point when the rendered
request preserves enough byte-identical prefix. So the clone's **first turn** can
cost roughly:

```
≈ 0.10 × shared_prefix_tokens   (cache read of the inherited context)
+ 1.00 × task_tokens            (the appended instruction)
+ output
```

That is the real answer to "without paying a caching cost": you cannot make it
free — at minimum you pay the ~10% read on the shared prefix — but you avoid the
full-price reprocessing a context-free subagent incurs, **and** you avoid the
parent spending tokens to brief it. Net marginal cost of a clone ≪ a subagent.

To improve hit rate the fork should preserve as much byte-identity as possible:
- Reuse the same model and thinking level.
- Keep tool policy stable for `mode:"inherit"`; default `read-only` deliberately changes tools for safety.
- Fork **promptly** (within the TTL of the parent's last call).

If a hit is missed, the result is still correct — you just pay full input once.
Caching is an optimisation layer, never a correctness dependency, and hard cache
pinning remains a future optimisation rather than a shipped guarantee.

---

## 5. Completion alert and collection

When the clone reaches `agent_end` and is idle (no queued work), pi-clones:
1. Extracts and stores the final assistant text in the parent session's in-memory clone record.
2. Sends the **parent** a concise completion alert with id, state, task, and a short sanitized preview. The alert steers a parent turn without dumping the clone's full result into context.
3. Leaves the full handoff available through `clone_result({id})`; `clone_log({id})` remains a diagnostic escape hatch when a result looks wrong.

This avoids duplicate context dumps when the parent is waiting on several clones: the parent watches status/alerts, then fetches only the full results it actually needs.

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
> Once you delegate work to a clone, do not repeat that same work yourself;
> continue only with non-overlapping parent work unless the clone reports a
> blocker or the user redirects you. Do not poll `clone_status` after starting
> background clones: completion alerts are pushed automatically, so check status
> only when the user asks, a clone seems stuck, or a meaningful delay has passed.
> Wait for a completion alert or terminal status before `clone_result`, use
> `clone_continue` with `mode:"inherit"` when a read-only clone needs to keep going
> with write tools, and use `clone_dismiss` to write off completed clones you no
> longer need in status lists. A clone has no user to ask: if it hits a decision
> only the human can make, it records the blocker in its final report and stops —
> it escalates to you, never to the user.

---

## 7. Surface (tools + command)

Minimal, primitive-first. One tool the agent reaches for, four thin verbs around it.

| Tool | Purpose |
|---|---|
| `clone` | Fork self + task; returns `clone_id` immediately by default. Optional `{ mode: "read-only"\|"inherit", background: boolean }`. |
| `clone_status` | `{id?, include?}` → one-off active-clone inspection by default; `include:"completed"` lists terminal clones that have not been written off, and `include:"all"` includes written-off records too. Rapid active-clone polls are suppressed because completion alerts are pushed automatically. |
| `clone_result` | `{id}` → final response after the clone reaches `done`/`error`/`stopped`. Running clones return a wait-for-alert reminder rather than encouraging polling. |
| `clone_continue` | `{id, task, mode?, background?}` → continue a terminal clone from its existing branch, optionally with `mode:"inherit"` to enable writes/tools instead of starting over. |
| `clone_log` | `{id, tail?}` → browse the clone transcript when a result looks nonsensical. |
| `clone_stop` | `{id}` → abort a clone. |
| `clone_dismiss` | `{id?}` → write off one terminal clone, or all terminal clones when omitted, so routine status lists stay focused on active work. |

Command: `/clones` — TUI list of active clones (token %, age, last activity), with a note when completed clones are waiting to be written off.

Status/liveness is built from the `AgentSession` event stream: `message_end`
stamps last-activity time + usage; `tool_execution_*` feeds current activity;
`getContextUsage()` feeds the percent.

---

## 8. Resume-hiding

Clone sessions live under a **non-default session directory**: each fork is a
flat file `~/.pi/agent/clones/<timestamp>_<cloneId>.jsonl` (Pi's standard session
filename, written by `SessionManager.forkFrom`), with its parent id and depth
recorded in an in-file `pi-clone-meta` entry rather than in the path. Pi's session
pickers and `pi-resume-search` enumerate via `SessionManager.listAll()` /
`list(cwd, sessionDir)`, which scan the default `~/.pi/agent/sessions/<encoded-cwd>/`
root — the sibling `clones/` dir is never listed. So clones are file-backed (giving
`clone_log` and the resume-as-fork seeding for free) yet structurally absent from
resume history. A root session (depth 0) prunes clone files older than the
retention window (`CLONE_RETENTION_MS`, 7 days) at `session_start`; clones skip
the sweep so they never delete each other's live files, and no tombstones
accumulate in the tree.

---

## 9. Concurrency & file safety

In-process clones share the parent's cwd and OS process. The honest hazard is
write contention, so the default is shaped to avoid it:

- **Default clones are read-only** (allowlist: `read, grep, find, ls`). This matches the stated use case — research/investigate in parallel — and is race-free by construction.
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
- Clone error/abort → surfaced via `clone_status` and the completion alert; `clone_result` returns the error plus any partial output when the parent needs it.
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
3. **Blocking-tool neutralisation — RESOLVED.** Headless allowlist drops `ask_user`, and clone guidance instructs clones to report human-only decisions as blockers.
4. **Cache proof — PRECONDITION MET, empirical check deferred (P2).** Inherited
   messages are byte-identical across the fork (proven), so the prefix *can* match.
   Confirm `cache_read_input_tokens` ≈ shared prefix on real clone turns before making stronger claims.
5. **Completion alert turn — RESOLVED.** `subscribe` → `agent_end` gives the completion signal; `sendMessage({triggerTurn, deliverAs:"followUp"})` steers a parent turn with a concise alert.

*Spike scripts:* `~/.pi/agent/tmp/clones-spike/` (`spike1-fork-resume.mjs`,
`spike2-createsession.mjs`) — all assertions green.

---

## 13. Phased implementation

- **P0 — fork + run + collect — DONE / live-verified.** `clone` (synchronous path)
  → `SessionManager.forkFrom` into hidden dir + depth meta → `createAgentSession`
  resume → `prompt` → `finalText` collect. Proven end-to-end in a real headless Pi
  (`CLONE_RESULT=PONG`).
- **P1 — background + completion alert + inspection — DONE.** Non-blocking `clone`
  (default), `subscribe` progress stream, `sendMessage({triggerTurn,deliverAs})`
  concise completion alert, active-only `clone_status`, `clone_result`, `clone_continue`,
  `clone_log`, `clone_stop`, `clone_dismiss`, `/clones`, lazy first-use advice, depth + concurrency guards,
  `session_shutdown` cleanup. (Background alert suits interactive sessions; a `pi -p`
  parent may exit before a background clone finishes — use synchronous there.)
- **P2 — cache hardening — PRECONDITION MET, empirical check pending.** Byte-identical
  inherited session entries proven; optional prompt pinning/cache breakpoint can harden the hit rate after verifying `cache_read_input_tokens`.
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
