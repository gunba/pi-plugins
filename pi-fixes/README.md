# pi-fixes

Bundled workarounds for upstream Pi issues, with built-in effectiveness tracking so each fix can be retired once it stops firing.

## Fixes

### Oversized single-message guard (`context-guard.ts`)

Automatic continuations after a tool call are sent inside the same run, before compaction can run, so one giant tool result can reach the provider and blow up the request. Using Pi's `context` event — the single point every provider request is built from — this strips any single message over the limit, saves the original to a markdown file, and replaces it with a concise pointer (tool results keep their `toolCallId`/`toolName` pairing).

- `/context-guard status | on | off | max 50k | user on|off | notify on|off`
- State: `~/.pi/agent/context-guard/` (`settings.json`, `stripped/*.md`).
- Env: `PI_CONTEXT_GUARD[_ENABLED]`, `PI_CONTEXT_GUARD_MAX_MESSAGE_TOKENS`, `PI_CONTEXT_GUARD_USER_MESSAGES`, `PI_CONTEXT_GUARD_NOTIFY`, `PI_CONTEXT_GUARD_SETTINGS`, `PI_CONTEXT_GUARD_DIR`, `PI_CONTEXT_GUARD_OUTPUT_DIR`.

### Claude effort lift (`claude-effort.ts`)

Pi's `ThinkingLevel` stops at `xhigh`, but Claude Fable 5 and Opus 4.7+ expose a higher `max` effort tier that Pi can't reach (on Fable 5 and opus-4-8, `xhigh` sends effort `"xhigh"`). Until upstream [issue #5361](https://github.com/earendil-works/pi/issues/5361) adds a real `max` level, this rewrites `output_config.effort` on the wire so Pi's five non-off thinking levels map 1:1 onto Anthropic's ladder `low < medium < high < xhigh < max` (so `xhigh` → `max`). It only touches models with the full Anthropic effort ladder (`claude-fable-5`, `claude-opus-4-7/4-8…`), so no model receives an effort it rejects, and it falls through untouched on any error.

- No commands or settings; it self-applies. Activations show in `/pi-fixes` as `claude-effort-remap`.
- Remove this file once #5361 ships a native `max` level.

## Effectiveness tracking (`effectiveness.ts`)

Every fix records an activation only when it actually prevents its failure. This is the signal for whether a workaround is still earning its place.

```text
/pi-fixes          # report each fix: total / last 7d / last 30d / last seen / verdict
/pi-fixes flush    # force-persist the in-memory counters now
```

Verdicts:

- **NEEDED** — fired within the last 30 days.
- **REVIEW** — fired before but not in the last 30 days; candidate for removal.
- **UNUSED** — never fired since tracking began; candidate for removal.

Activations are appended (per-process, subagent-safe) to `~/.pi/agent/pi-fixes/effectiveness.ndjson`. Override the directory with `PI_FIXES_DIR`.

Record from another extension without importing this module:

```ts
(globalThis as Record<symbol, unknown>)[Symbol.for("pi.fixes.effectiveness")]
  ?.record?.("your-fix-id", 1);
```
