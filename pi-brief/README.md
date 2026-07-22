# pi-brief

Turn weak user intent into a precise, reviewable task brief and then start a
fresh Pi conversation with the approved brief.

## Usage

```text
/brief <task>
```

`/brief <task>` starts brief authoring and asks the current model to render a
complete first draft in a structured TUI card. The card is the review surface from
the first draft onward. Reply normally with corrections or answers; every changed
revision appears as another complete card before it can be approved.

Every brief includes an execution process, explicit time horizon and minimum
effort, persistence rules against arbitrary early exit, a partial-work policy,
acceptance criteria, near-miss exclusions, edge cases, adversarial verification,
deliverables, and stopping conditions.

The agent can inspect the project and use the existing research tools while refining
the brief. Each rendered revision is also autosaved under `.pi/briefs/` as a recovery
copy. You do not need to open that file to review the brief. You may edit it outside
Pi if useful.

When the user approves the latest visible revision in normal conversation, the agent
submits only the approval through `present_brief`; the stored revision is not
resubmitted or rendered again. Pi waits for the brief turn to settle, replaces the
current conversation directly, names the new session after the brief, sends the
compiled brief as its first user message, and begins execution there. If an
interrupted or reloaded session cannot complete that automatic handoff, run
`/brief approve` to retry it.

Press the normal tool-expansion key (usually `ctrl+o`) to switch a brief card
between its compact summary and full specification. Validation errors also stay
compact by default and reveal the rejected payload only when expanded.
