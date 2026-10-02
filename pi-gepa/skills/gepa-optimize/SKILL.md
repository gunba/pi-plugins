---
name: gepa-optimize
description: Optimise prompts or other scorable text with GEPA, native Pi models and a feedback-rich evaluator. Use for bounded prompt tuning, evaluator calibration or text-artifact search when training, validation and independent holdout examples are available.
---

# GEPA optimisation

Use the actual GEPA optimiser through `scripts/run.py`; do not substitute a manually rewritten prompt or describe validation scores as held-out gains.

Read [the runtime contract](references/runtime.md) to prepare a private run. Read [the upstream contract](references/upstream.md) when changing the integration, choosing a metric or interpreting results.

## Prepare

1. Define the task, seed, higher-is-better metric and actionable failure feedback. Freeze the evaluator and splits before search. Split by source/task identity, not merely by different wording. Keep the holdout unavailable to reflection and candidate selection.
2. Use the current Pi provider/model and thinking level. The bridge uses existing native authentication and configured compatible endpoints; it does not load provider extensions, agent tools, skills or conversation history. Inspect model/auth availability before assuming a new paid API key is needed. A different model or thinking level needs the user's approval.
3. Keep task prompts, examples, evaluator code, outputs and run directories outside the installed package, preferably under `~/.pi/plans` or a temporary directory. Place the task evaluator beside the private config.
4. Set search-evaluation, candidate-proposal, total model-call and wall-clock budgets explicitly. Include baseline passes, task and judge calls inside each evaluation, reflection, and two post-search holdout passes in the model-call allowance. Limit hosted-model concurrency separately from cheap CPU work.

## Run

Run the preflight with a separate fresh `run_dir` and `--preflight`; it checks native access without generating text. Then run the prepared search config. `scripts/run.py` records raw model requests/responses, scores, input hashes, the candidate pool and the frozen winner in its private run directory.

The baseline is scored on training and validation before search. GEPA reflects on training feedback and selects on validation. The runner opens the holdout only after search, then scores the seed and winner there. Holdout feedback never returns to the optimiser. Infrastructure/authentication failures abort rather than becoming low-quality training examples.

If the seed has no training failures, report saturation instead of burning the whole budget. If selection improves but holdout does not, report that result without tuning against the same holdout. A revised experiment needs a new untouched holdout.

## Report

Report baseline training/validation, selected validation and seed/winner holdout scores, split sizes, accepted candidate-pool size and proposal attempts, search evaluations, all model calls, token usage, model/thinking, elapsed time and stop reason. Distinguish native catalog cost estimates from billed usage or subscription limits. Link private evidence locally; promote only an intentionally reviewed candidate, not datasets or experiment logs.

For stochastic tasks, average repeated task/judge samples inside the evaluator and include those calls in the budget. Treat a small single-run gain as an integration result, not broad efficacy. For subjective writing, calibrate against independent expert judgments; same-model judging or a human/model score gap is not independent writing-quality validation. Prompt search does not reproduce weight-training results.
