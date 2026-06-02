# pi-context-guard

Pi extension that prevents a single oversized context item from reaching the model.

It uses Pi's `context` event as the single invariant point: every provider request, including automatic continuations after tool calls, is built from this context. If a tool result, extension custom message, bash output, assistant message, or older user message is too large, the extension replaces that item with a concise warning before it can be sent to the provider. Tool results keep their `toolCallId`/`toolName` pairing so provider tool protocols remain valid.

## Defaults

- Enabled by default.
- Per-message guardrail: `50k` estimated tokens.
- The latest user prompt is protected by default; set `user on` only if you want pasted user prompts guarded too.

Pi's normal compaction/overflow path remains responsible for total-context pressure. This extension only strips pathological single messages.

## Commands

```text
/context-guard status
/context-guard on
/context-guard off
/context-guard max 50k
/context-guard user on
/context-guard user off
/context-guard notify on
/context-guard notify off
```

Settings persist to:

```text
~/.pi/agent/context-guard/settings.json
```

## Environment overrides

- `PI_CONTEXT_GUARD` / `PI_CONTEXT_GUARD_ENABLED`
- `PI_CONTEXT_GUARD_MAX_MESSAGE_TOKENS`
- `PI_CONTEXT_GUARD_USER_MESSAGES`
- `PI_CONTEXT_GUARD_NOTIFY`
- `PI_CONTEXT_GUARD_SETTINGS`

## Why

Auto-compaction usually runs after an agent run ends. Automatic continuations after tool calls happen inside the same run, so a very large tool result can otherwise be appended and immediately sent to the provider before compaction gets a chance to run. This extension strips that one item at the final context boundary.
