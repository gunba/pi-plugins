# pi-brief

Turn weak user intent into a precise, reviewable task brief and then start a
fresh Pi conversation with the approved brief.

## Usage

```text
/brief <task>
```

`/brief <task>` starts brief authoring and asks the current model to render a
complete first draft in a structured chat card. Reply normally with corrections,
answers, or approval; the model renders complete revised briefs as the conversation
develops.

Every brief includes an execution process, explicit time horizon and minimum
effort, persistence rules against arbitrary early exit, a partial-work policy,
acceptance criteria, near-miss exclusions, edge cases, adversarial verification,
deliverables, and stopping conditions.

The agent can inspect the project and use the existing research tools while refining
the brief. Each rendered revision is also written to a project-local Markdown file
under `.pi/briefs/`, so the prompt can be reviewed or edited outside the chat.

When the user approves the result in normal conversation, the agent submits the
approval through `present_brief`. Pi replaces the current conversation, names the
new session after the brief, sends the compiled brief as its first user message,
and begins execution there.

Press the normal tool-expansion key (usually `ctrl+o`) to switch a brief card
between its compact summary and full specification.
