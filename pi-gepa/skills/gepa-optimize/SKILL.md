---
name: gepa-optimize
description: Optimise prompts, skills or other scorable text with GEPA, native Pi models and a feedback-rich evaluator. Use for bounded prompt or skill tuning, evaluator calibration or text-artifact search, including evaluations that run agent sessions, when training, validation and holdout examples are available.
---

# GEPA optimisation

Use the actual GEPA optimiser; do not substitute a manually rewritten prompt or describe validation scores as held-out gains. `scripts/run.py` runs text-completion tasks. For tasks scored by agent sessions or produced artifacts, call GEPA's Python API from a private runner (see [Agent-run evaluators](#agent-run-evaluators)).

Read [the runtime contract](references/runtime.md) to prepare a private run. Read [the upstream contract](references/upstream.md) when changing the integration, choosing a metric or interpreting results.

## Design the experiment

Most failed searches were already lost before the first proposal. Settle these points, and show the baseline evidence, before spending a search budget.

1. **The metric has a gradient.** Score how close an output is, not only whether it passes. Use a continuous measure, such as log relative error or partial credit per item, and keep pass/fail controls for reporting. Score each independent quantity once; a total or rate derived from other scored items repeats the same error. If the seed scores at or near 0 or 1 on most examples, the search has nothing to climb.
2. **Validation can separate candidates.** GEPA keeps the seed when candidates tie on validation. Use several validation examples (at least three or four, more for noisy tasks) and check that the seed's validation scores vary and sit between the floor and the ceiling.
3. **Noise is measured.** For stochastic tasks such as agent runs or sampled models, score the seed twice on a few examples first. When the improvement you hope to detect is not clearly larger than the run-to-run spread, average repeated samples inside the evaluator. Cache evaluations so a parent is not resampled each iteration; otherwise acceptance depends on which sample was lucky.
4. **Feedback explains failures.** Return expected and actual values for each item, the size of each error, and for agent tasks a condensed trajectory: inputs opened and not opened, key steps, errors and final notes. Avoid raw output dumps and keep each example's feedback to a few thousand words.
5. **Ground truth stays independent.** Do not edit reference answers to match the seed's assumptions or to overrule expert judgement. Correct only obvious mechanical defects, such as formula errors, transpositions or a label the author plainly meant, and record each correction. Ask the user in neutral terms. Do not add invented facts to task inputs to make a reference reachable; drop the dependent check or accept the alternative answers instead.
6. **Examples are solvable from their inputs.** Inspect the seed's largest errors. An error caused by missing evidence cannot be learned from prompt text: restore the evidence or drop the affected check.
7. **The right text is editable.** For a multi-file skill, use a dictionary seed with one component per file so each proposal edits one file. Keep files fixed when the task cannot benefit from editing them. When examples use different components, for example office-specific guides, cache results by the text each example actually uses.
8. **Time and budget are explicit.** Estimate time and tokens per evaluation, then size proposals, repeats, minibatch and concurrency so the run finishes in hours. Run evaluations in parallel up to machine and provider limits. With few training examples, use a minibatch covering all of them. If the baseline shows no usable signal, stop and redesign instead of running the full budget.

## Prepare

1. Define the task, seed, higher-is-better metric and actionable failure feedback. Freeze the evaluator and splits before search. Split by source/task identity, not merely by different wording. Keep the holdout unavailable to reflection and candidate selection.
2. Use the current Pi provider/model and thinking level. The bridge uses existing native authentication and configured compatible endpoints; it does not load provider extensions, agent tools, skills or conversation history. Inspect model/auth availability before assuming a new paid API key is needed. A different model or thinking level needs the user's approval.
3. Keep task prompts, examples, evaluator code, outputs and run directories outside the installed package, preferably under `~/.pi/plans` or a temporary directory. Place the task evaluator beside the private config.
4. Set search-evaluation, candidate-proposal, total model-call and wall-clock budgets explicitly. Include baseline passes, task and judge calls inside each evaluation, reflection, and two post-search holdout passes in the model-call allowance. Limit hosted-model concurrency separately from cheap CPU work.

## Run

Run the preflight with a separate fresh `run_dir` and `--preflight`; it checks native access without generating text. Then run the prepared search config. `scripts/run.py` records raw model requests/responses, scores, input hashes, the candidate pool and the frozen winner in its private run directory.

The baseline is scored on training and validation before search. The run stops before search when the seed already passes every training example or every validation example scores the same floor or ceiling. GEPA reflects on training feedback and selects on validation. The runner opens the holdout only after search, then scores the seed and winner there. Holdout feedback never returns to the optimiser. Infrastructure/authentication failures abort rather than becoming low-quality training examples.

If selection improves but holdout does not, report that result without tuning against the same holdout. A revised experiment needs a new untouched holdout.

## Agent-run evaluators

When an evaluation runs an agent that produces files, write a private runner around `gepa.gepa_launcher.optimize_anything` with a dictionary seed. Keep these properties:

- each evaluation stages fresh inputs in its own workspace and runs a fresh session with the candidate text applied;
- finished runs are cached on disk by the candidate text the example uses, so a restarted study reuses them, and interrupted sessions resume rather than restart;
- infrastructure failures raise an exception derived from `BaseException`, which GEPA does not convert into a zero score;
- when the grader cannot verify an output for reasons unrelated to the candidate, score what can be read, flag it in the feedback and keep counting how often it happens; a zero would add noise, not information;
- task time and tokens are recorded beside the score, not folded into it;
- call ledgers store request metadata, not full conversation contexts, which grow quadratically with session length;
- large per-run copies (runtimes, staged inputs, skill bundles) are deleted once a run is graded;
- sessions that stop writing and using CPU are stopped and resumed, and a run that stops is restarted from saved state rather than waiting for the user;
- an unattended run keeps the machine awake; on Windows with Modern Standby this needs the display-required flag as well as system-required;
- on Windows, run Python with `-X utf8`; GEPA writes its state files with the default encoding.

## Report

Report baseline training/validation, selected validation and seed/winner holdout scores, split sizes, accepted candidate-pool size and proposal attempts, search evaluations, all model calls, token usage, model/thinking, elapsed time and stop reason. Distinguish native catalog cost estimates from billed usage or subscription limits. Link private evidence locally; promote only an intentionally reviewed candidate, not datasets or experiment logs.

Treat a small single-run gain as an integration result, not broad efficacy. For subjective writing, calibrate against independent expert judgements; same-model judging or a human/model score gap is not independent writing-quality validation. Prompt search does not reproduce weight-training results.
