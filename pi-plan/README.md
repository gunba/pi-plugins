# Pi Plan

One native, branch-local plan contains an objective, ordered steps and optional
automatic continuation. Manual checklists do not start extra model rounds.
Built for Pi 0.87.1 or newer; the root package loads the extension.

## Use

`/plan` opens its details. `/plan <objective>` creates a manual plan.
The management screen offers objective and step editing, step status, continuation
settings, pause/resume, completion and confirmed clear. Native dialogs work in
both terminal Pi and Desk. The terminal Work summary and Desk conversation
preview show the objective and current step.

Direct commands: `/plan pause`, `/plan resume`, `/plan complete`, `/plan clear`,
`/plan auto on` and `/plan auto off`.

Model tools:

- `get_plan` reads the current plan and exact id/revision.
- `create_plan` accepts an objective, optional steps, `auto_continue` and
  `max_rounds`. Continuation defaults to false.
- `update_plan` uses `plan_id`, `revision` and `action`. Edit changes only supplied
  fields; `steps` replaces the complete list. Other actions are pause, resume,
  complete and blocked.

Step states are pending, in_progress and completed. Parallel active steps are
allowed; normalized step content must be unique. Steps persist across turns.
Outstanding steps prevent completion, but finishing every step does not by
itself prove the objective complete.

## Continuation

Automatic mode uses bounded same-session rounds, with a default limit of 256.
Enabling it on an active manual plan arms continuation. Ordinary edits do not
rearm restored work. Session start, reload, fork and tree navigation always
restore plans disarmed; Resume rearms automatic plans. Manual paused plans
resume without becoming automatic.

Pending human work, explicit event waits, native UI editing and an in-flight
round reservation prevent competing dispatch. Errors and token limits disarm;
cancellation of an owned round pauses it. Automatic blocker reports require at
least three admitted rounds and a concrete reason.

Managed children have their own branch-local plans and inherit the extension
through native tool-source metadata. Their owning runtime controls task
continuation; this extension does not start a second child driver.

## Persistence and cutover

Plan snapshots, tombstones and round admissions use hidden native custom entries.
Replay checks revisions, identities, transitions, timestamps, counters and exact
round content. If the native branch begins at a missing parent and its leading
plan record is a change, that record supplies a checkpoint. Recovery retains the saved revision,
steps, phase and round count, leaves continuation disarmed, and validates every
later change and admission normally. It does not rewrite history or reconstruct
missing messages. A branch without a usable checkpoint, or with invalid retained
plan records, still fails closed.

Existing goal state and the current todo list import once per selected branch.
The importer preserves goal identity and counters and respects prior task clears.
Todo-only state becomes a manual plan. It verifies the import against the original
records rather than rewriting them. The retired formats are read-only migration
input; new writes use one plan store. Old goal/todo commands and tools are removed.

Pi's public extension API supplies no atomic pre-model fence or explicit append
flush. Custom message source attribution is not an authentication boundary.
Enqueue acknowledgement is still inferred from matching native events. These
limits also apply to unattended continuation.

## Development

```sh
node --test pi-plan/tests/*.test.mjs
npm run typecheck
```

The earlier goal state-machine design was based on
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness/tree/99f6f02fecdb7dff40c3fbc9470f5907c29f74ca),
Copyright © 2026 DeepSeek, MIT licensed. This is an independent implementation.
