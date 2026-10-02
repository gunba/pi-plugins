# Upstream contract

Reviewed revision: [`fb1ed589fd83372caef499cffc2c73173d3b096b`](https://github.com/gepa-ai/gepa/tree/fb1ed589fd83372caef499cffc2c73173d3b096b).

- [Agent skill](https://github.com/gepa-ai/gepa/blob/fb1ed589fd83372caef499cffc2c73173d3b096b/.claude/skills/gepa-optimize-anything/SKILL.md) and [guide](https://gepa-ai.github.io/gepa/guides/agent-skill/): coding agents author evaluators and drive `optimize_anything`; the skill is not the optimiser itself.
- [Public API](https://github.com/gepa-ai/gepa/blob/fb1ed589fd83372caef499cffc2c73173d3b096b/src/gepa/optimize_anything.py): a text seed, evaluator, training examples and validation examples yield a candidate pool and selected winner. The runner deliberately supports the GEPA backend only.
- [Evaluator guidance](https://github.com/gepa-ai/gepa/blob/fb1ed589fd83372caef499cffc2c73173d3b096b/.claude/skills/gepa-optimize-anything/references/writing_evaluators.md): return a finite higher-is-better score and an actionable feedback dictionary. Error details, actual output, expected output and failed checks are useful reflection input. Gate quality on correctness rather than a gameable proxy.
- [LM protocol](https://github.com/gepa-ai/gepa/blob/fb1ed589fd83372caef499cffc2c73173d3b096b/src/gepa/proposer/reflective_mutation/base.py): a callable takes a string or text-chat messages and returns completion text. This permits the Pi bridge without LiteLLM or a new provider key.

## Splits and budgets

Training drives reflection and minibatch acceptance; validation drives final candidate selection. Selection scores are optimistically biased after repeated search. Upstream `test_set` evaluates only seed and winner after search and sits outside `max_evals`. This runner implements the same reporting stage explicitly, opening the holdout after the winner is frozen and counting its model requests against the total-call budget.

The other upstream engines have different prerequisites and selection semantics: AutoResearch and MetaHarness use Claude subprocesses and combine training with validation; best-of-N is a non-reflective baseline. None is enabled here.

Upstream recommends roughly 15–20 candidates' worth of selection evaluations for substantive search. Small bounded trials can establish working integration but cannot establish superiority over manual revision or best-of-N. Count actual proposals and accepted candidates; training saturation can reject every proposal.

## Dependencies and maintenance

The pinned base package declares no runtime dependencies and supports Python 3.10–3.14. Its `full` extra includes LiteLLM, datasets, experiment trackers and native dependencies; it is not needed here. The runner disables cloudpickle serialization, evaluation caching and progress bars. Candidate text is passed to the evaluator, never executed by the runner. An evaluator that executes generated code needs its own isolation boundary.

MIT licence: [upstream licence](https://github.com/gepa-ai/gepa/blob/fb1ed589fd83372caef499cffc2c73173d3b096b/LICENSE), also preserved at `../../../LICENSE.gepa`.

When updating the pin, inspect the actual skill, Python config/evaluator/result contracts and dependency declarations together. Update `scripts/requirements.txt`, `UPSTREAM_REVISION` in `scripts/run.py` and this reference in one change; run a bounded real evaluation before accepting it. Published documentation may lag the source: this revision's prose says dict seeds are unsupported at the public API, while its implementation permits them. The runner intentionally accepts one text candidate.
