# Work coordination

Shared helpers for the plugins that run agents.

- `ensureWorkCoordination(pi, { child })` records, once per runtime event bus, whether the session is a root
  conversation or an SDK child that pi-agents runs as a secondary agent. `isManagedChild(pi)` reads it: a managed child's parent owns its
  turns, so plugins such as pi-plan and pi-agents leave its turns alone.
- `nativePromptPreparing(sessionManager)` (`native-queue.ts`) is true while Pi is admitting a prompt, when `isIdle()`
  is still true, so other plugins don't start a competing turn.

There is no waiting tool. Agents wait with `watch` (pi-watch), and reports from secondary agents wake the conversation
that started them (pi-agents).
