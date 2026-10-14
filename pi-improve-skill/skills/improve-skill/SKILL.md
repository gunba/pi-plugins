---
name: improve-skill
description: "Improve an agent skill against benchmark cases in stateless rounds. The task model runs the cases and then reconciles its own output against the reference; a fresh session on the strongest model reviews those findings, investigates, edits the skill and leaves notes for the next round; held-out cases are run when a round improves. Use when a skill's results on known cases should get better, especially when runs are slow or noisy or need expert judgement to assess."
---

# Improve a skill

A driver script repeats rounds. Each round the task model does the bulk of the work, running the cases and explaining its own mistakes. Then a new reviewer session on the strongest model decides whether the last change helped and makes the next one. Reviewer sessions do not carry context from round to round; `notes.md` does.

## A round

1. **Trials.** Run every training case several times with the candidate skill. After a run is scored, copy its output so it stays as scored, then send the same agent session a follow-up with the reference. It knows why it made each choice. Ask it to compare its output with the reference item by item, trace each difference to the evidence, and classify each cause: skill missing, wrong or unclear; skill ignored; slip; evidence ambiguous or a legitimate judgement; reference error. It should quote the files, rows and skill passages that show it, in under 600 words.
2. **Review.** Start a new reviewer session. It reads `notes.md`, the round's scores beside the best version's, and the agents' findings, investigates, writes its verdict, edits the skill and adds to `notes.md`. See [the reviewer's steps](#reviewing-a-round).
3. **Holdout.** When the verdict is "improved", run the held-out cases and compare their aggregate scores with the best version's. Not worse: the candidate becomes the best version. Worse: return to the best version and record that in `notes.md`.

With no run record yet, the first round runs the unchanged skill to obtain one, and runs the holdout once. Stop when the reviewer finds nothing more worth trying, after a set number of rounds, or after several rounds in a row without an improvement.

## Setting up the driver

These are the usual ways a fresh setup goes wrong.

- **Models.** Name the exact provider/model and effort for each role in the driver's configuration, and pass them when each session is created: for example the task model `openai-codex/gpt-6.1-sol` at `xhigh` and the reviewer a Claude Opus model at `xhigh`. Create sessions directly, with the agent SDK or headless `pi` and its model and thinking options. Do not rely on a session spawning subagents with a model override, which asks a person for approval. Check that both providers are authenticated before the first round.
- **Unattended.** Nothing may wait for a person. Before the first round, run one short session of each role headless and confirm it finishes on its own.
- **No artificial limits on the agents.** A trial agent gets what a user's session would: its normal tools and extensions, internet access and web search, and the usual time and output limits. Removing these measures a different agent from the one you are improving. The one restriction is what it can read. A trial sees its own case inputs and the skill, never the reference or another case's files. The reference reaches it only in the follow-up, after its output has been copied.
- **The reviewer has broad access.** It can read all training cases, references, run folders and the agents' findings, open and recalculate workbooks, run scripts and use the internet. Held-out cases are off limits. The driver gives it holdout aggregates only, and it must never open holdout inputs, outputs or per-case results.
- **Scores count decisions, not closeness.** An output is right or wrong on each point the evidence decides; points of genuine judgement accept any defensible treatment. A figure that is nearly right usually hides one wrong decision.
- **Records.** Keep every skill version (with a hash), its runs and scores. Resume interrupted trials instead of rerunning them. Run trials and follow-ups in parallel up to the machine's and provider's limits.

## Reviewing a round

You are a fresh reviewer. Work from the files, not from memory of earlier rounds.

1. Read `notes.md`: what has been tried, the evidence, the results, and ideas judged not worth trying.
2. Compare this round's scores with the best version's, case by case, against each case's run-to-run spread. Write the verdict to `review.json`: `improved`, `not improved` or `baseline`, with reasons. A difference smaller than a case's spread is not evidence. Count a change as improved only when the cases it targeted improve and no variant of the skill gets worse.
3. Read the agents' findings. Check against the files any finding that will drive a change; an agent can rationalise its own choices.
4. Look for patterns across cases and runs. A cause seen once is an anecdote; one seen in several cases, or in most runs of one case, is worth a change. Note what the agent already gets right, so a change does not disturb it.
5. Choose one change and its form: guidance text, a worked example, a script or check the agent runs, or a template fix. Prefer the form that removes the error mechanically. Scope a rule to the facts that decide it and say what it does not cover; a broad rule drawn from one case is the usual way a fix breaks other cases. Do not retry an idea `notes.md` records as failed unless you change what made it fail.
6. Edit the skill copy the driver gives you (the candidate if your verdict is "improved", otherwise the best version) and validate it with the skill's tests and checks.
7. Add to `notes.md`: the verdict, the evidence for your change, the change, and which results it should move. Keep entries short; later reviewers read the whole file. Set `stop` in `review.json` if nothing more is worth trying.

## Finish

Report the changes kept, per-case results before and after, the holdout aggregates, what was tried and failed, and the next most promising ideas. Hand the diff to the skill's owner for release.
