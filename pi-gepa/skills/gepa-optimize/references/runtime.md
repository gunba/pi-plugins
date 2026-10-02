# Runtime contract

- [Environment](#environment)
- [Private run config](#private-run-config)
- [Evaluator module](#evaluator-module)
- [Invocation and evidence](#invocation-and-evidence)

## Environment

Use Node 22.19+ and Python 3.10–3.14. Use the host's `@earendil-works/pi-coding-agent` and `@earendil-works/pi-ai` packages with the native `ModelRuntime` API (Pi 1.0). Do not install another SDK copy for this skill.

If package resolution cannot find the host SDK, set `PI_GEPA_MODULE_ROOT` for this invocation to the directory containing its `node_modules` (the pinned runtime's `source/pi-desk` for managed Desk). The bridge resolves public ESM exports from that SDK, including its nested AI dependency. Standalone Node scripts do not receive Pi's extension import mapping. `PI_CODING_AGENT_DIR` selects the existing native auth/models directory, defaulting to `~/.pi/agent`.

The bridge reads native credentials without modifying them, uses an in-memory model store and does not refresh catalogs. Tokens requiring refresh stop the run; let an authenticated Pi session refresh normally before retrying. It supports built-in chat providers and compatible endpoints in `models.json`, not providers or virtual models registered only by extensions. It sends isolated text completions, not autonomous agents. No skills, tools, instructions or session history are loaded. Codex uses Pi's native `openai-codex` provider and existing OAuth, not the Codex CLI or an `OPENAI_API_KEY` fallback.

Create an isolated Python environment outside the package. Install only the pinned base GEPA package, for example:

```sh
python3 -m venv ~/.pi/plans/gepa-env
~/.pi/plans/gepa-env/bin/python -m pip install --no-deps -r scripts/requirements.txt
```

On Windows use the environment's `Scripts/python.exe`. An existing checkout of the pinned upstream revision can instead be supplied through `PYTHONPATH=<checkout>/src`. No LiteLLM, DSPy, tracker, Claude CLI or GEPA `full` extra is required. Preflight verifies the installed Git commit through package provenance or the source checkout before any completion.

## Private run config

Resolve all paths below from the config file's directory. Arrays are opaque examples interpreted by the evaluator. Use a fresh `run_dir` on every invocation, including preflight. The runner rejects inputs/outputs inside the installed package.

```json
{
  "seed": "seed.txt",
  "train": "train.json",
  "validation": "validation.json",
  "holdout": "holdout.json",
  "evaluator": "evaluate.py",
  "run_dir": "run-01",
  "objective": "Maximise exact task correctness and output validity.",
  "background": "Task rules and constraints known before splitting examples.",
  "reflection_model": {
    "provider": "CURRENT_PROVIDER",
    "id": "CURRENT_MODEL",
    "thinking": "CURRENT_THINKING",
    "maxTokens": 8192
  },
  "task_model": {
    "provider": "CURRENT_PROVIDER",
    "id": "CURRENT_MODEL",
    "thinking": "CURRENT_THINKING",
    "maxTokens": 8192
  },
  "budget": {
    "max_evals": 120,
    "max_proposals": 15,
    "max_model_calls": 180,
    "max_seconds": 1200,
    "request_seconds": 180
  },
  "workers": 4,
  "minibatch_size": 3,
  "seed_number": 0,
  "stop_at_score": 1.0
}
```

Replace model placeholders from the session's `PI_PROVIDER`, `PI_MODEL` and `PI_REASONING_LEVEL`, or verified native session/default values. The runner never picks a provider or changes global defaults. Omit `task_model` for deterministic artifact evaluation; keep `reflection_model`. Set concurrency to available cores for CPU-bound evaluators; use an explicit rate-conscious limit for hosted models. The search seed fixes sampling order, not provider generation randomness.

The search evaluation cap does not include initial baseline or final holdout evaluations. The model-call cap includes every request through the bridge, including task/judge requests and reflection, but cannot count direct API calls made independently by an evaluator. Native retries are disabled. Wall-clock checks occur before requests and between GEPA iterations; model requests have their own abort timeout. Evaluators must bound their own execution, especially if they run subprocesses.

## Evaluator module

Export `evaluate(candidate, example, task_lm) -> (score, feedback)`:

```python
import json

def evaluate(candidate, example, task_lm):
    output = task_lm([
        {"role": "system", "content": candidate},
        {"role": "user", "content": example["input"]},
    ])
    try:
        prediction = json.loads(output)
    except json.JSONDecodeError as error:
        return 0.0, {"input": example["input"], "output": output,
                     "error": str(error), "expected": example["expected"]}
    score = float(prediction == example["expected"])
    return score, {"input": example["input"], "output": output,
                   "expected": example["expected"]}
```

The runner adds the `task_lm` argument then adapts this to upstream's two-argument evaluator contract. `task_lm(prompt) -> text` accepts a string or system/user/assistant text messages. Multiple calls permit repeated samples or same-model judges, all within the total-call cap. Do not use it to expose expected answers to the task model. It is `None` in deterministic runs.

Return metric failures as low scores with concrete feedback. Let authentication, quota, transport and budget exceptions propagate. The runner validates finite numeric scores and JSON-serialisable feedback. Evaluators are trusted Python code and may run concurrently. The runner does not execute or sandbox candidate text.

## Invocation and evidence

```sh
python scripts/run.py /absolute/private/preflight.json --preflight
python scripts/run.py /absolute/private/config.json
```

- `result.json`: budget, input hashes, model access, baseline train/validation, selection scores, accepted/attempted proposals, stop reason and independent seed/winner holdout scores, usage, status/errors.
- `model-calls.jsonl`: request starts and completed text/usage or errors, with roles and IDs; attempts count before dispatch.
- `evaluations.jsonl`: candidate/example hashes, metric scores and actionable feedback.
- `candidate-pool.json`, `winner.txt`, `search/iterations/`: accepted candidates, selected text and attempted proposals, including rejections.
- `bridge.stderr`: native process errors, kept private.

Holdout is hashed before search and decoded only after selecting/writing the winner. Dataset/evaluator hashes must remain unchanged. Exact-row duplicate checks do not replace source-disjoint splitting. Re-running the same holdout after tuning invalidates its independent status.

Native token/cost reports are recorded separately from GEPA's reflection-only cost. Catalog estimates do not establish billing, available subscription quota or a hard dollar cap. Runs are bounded by attempted model calls, output caps, search evaluations, candidate proposals and request time; there is no automatic resume or promotion. After a failure, use the recorded artifacts to start a new bounded run, without feeding inspected holdout cases back into search.
