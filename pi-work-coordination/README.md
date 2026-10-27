# Work coordination

Shared helpers for the plugins that run agents.

- `ensureWorkCoordination(pi, { child })` records, once per runtime event bus, whether the session is a root
  conversation or an SDK child that pi-agents runs as a secondary agent. `isManagedChild(pi)` reads it: a managed child's parent owns its
  turns, so plugins such as pi-plan and pi-agents leave its turns alone.
- `nativePromptPreparing(sessionManager)` (`native-queue.ts`) is true while Pi is admitting a prompt, when `isIdle()`
  is still true, so other plugins don't start a competing turn.

This package registers neither a waiting tool nor a wake tool. Agents subscribe with [`watch`](../pi-watch/README.md#watch-versus-wake); waking is event delivery, not another subscription. Reports from secondary agents wake the conversation that started them through pi-agents, without creating a timer.
