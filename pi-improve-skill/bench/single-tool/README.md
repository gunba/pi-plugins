# Single-tool comparison

**Recommendation: keep this as a draft, not a default rollout.** A script-only
interface reduced definition and workflow input costs, but the real repository
change was slower on both models. GPT 6 also used more output tokens in the workflow
suite. Keep the current direct coding tools plus codemode in production until a
single-tool primitive fast path or another candidate has supporting measurements.

## Method

- Models: `anthropic/claude-opus-5-5` and `openai-codex/gpt-6-sol`, high reasoning.
- Node 22.23.4, Linux/x64. Fresh native SDK sessions, normal provider authentication,
  the Anthropic auth extension and Codex Wire. No custom token refresh code.
- Current: ordinary tools plus native codemode and tool_search. Single: the adapter
  in `pi-tools`, using the same operation implementations and sandbox.
- Same headless tools and policies in both arms: core files/shell, output budgeting,
  command guard, plans, watches, show, ask_user, web, memory and agent operations.
  Browser/MCP connections and unrelated project prompts were not loaded. This is
  a controlled tool-interface comparison, not a capture of a full personal Desk
  environment.
- Four concurrent trials. Each model/task/arm ran twice; arm launch order reversed
  in repetition two. Fresh sessions may share provider prompt caches. No seed or
  cold-cache guarantee is claimed.
- The runner follows the existing `pi-improve-skill/bench` pattern: isolated trial
  directories, native traces and usage, resumable completed trials, deterministic
  checks instead of a model judge. No timed-out/error trial was silently retried.
- Six workflow tasks were fixed before measurement: targeted bug repair; a 100-line
  literal containing quotes/backticks/backslashes/interpolation syntax; aggregation
  of 12,000 shell records; selective agent messaging; plan/show/watch lifecycle;
  and read → real Jev classification → conditional write in one call.
- Agent routing uses real agent tool definitions with a deterministic remote
  transport fixture. It does **not** measure another agent's generation or live
  cross-computer network latency. Jev calls were real.
- Success checks execute code/tests, compare output files, verify message recipients
  and operation traces, and inspect plan/watch state. `cases.mjs` contains the exact
  prompts, fixtures and checks.
- Wall times include SDK startup and shutdown. This was a shared desktop, not an
  isolated timing machine. A 19-second low-priority test run overlapped part of the
  workflow run. Treat timing as descriptive, especially with two repetitions.

`input`, `cached`, `cacheWrite`, `output`, model requests, model-issued tool calls,
nested operations and seconds are retained per trial in
[`measurements.json`](measurements.json). **New input** below is `input + cacheWrite`;
**total input** is new input plus cached input. Output includes provider-reported
reasoning tokens. Jev's recorded tokens are separate in `auxiliaryTokens` and are
not attributed to either chat model. Calls below are model-issued calls, not every
nested operation. Seconds are summed task durations, not elapsed parallel-run time.

## Fixed workflow results

Each row contains 12 trials: six tasks × two repetitions.

| Model | Interface | Success | New input | Cached input | Output | Calls | Task seconds |
|---|---|---:|---:|---:|---:|---:|---:|
| Opus 5.5 | Current | 12/12 | 52,038 | 439,858 | 17,753 | 46 | 213.2 |
| Opus 5.5 | Single | 12/12 | 35,746 | 114,509 | 12,316 | 32 | 153.2 |
| GPT 6 Sol | Current | 12/12 | 76,235 | 267,520 | 6,648 | 46 | 216.9 |
| GPT 6 Sol | Single | 12/12 | 51,624 | 77,184 | 7,374 | 41 | 223.5 |

The provider-neutral serialized definitions were **18,938 → 3,324 bytes** (82.4%
smaller). The single definition stayed unchanged across requests and discovery.
Its test ceiling is 3,584 bytes, about 8% above the measured size. These are exact
UTF-8 byte sizes, not tokenizer estimates.

Total chat input fell 69.5% for Opus and 62.5% for GPT. Opus output fell 30.6%; GPT
output **rose 10.9%**. Summed workflow time fell 28.1% for Opus but **rose 3.1%** for GPT.

The coding subset alone does not justify a blanket conclusion:

| Task group | Opus current → single seconds | GPT current → single seconds |
|---|---:|---:|
| Three file/shell workflows, two repetitions | 150.7 → 74.5 | 121.0 → 113.5 |
| Two coordination workflows, two repetitions | 38.6 → 39.2 | 66.9 → 80.6 |
| Classify-and-act, two repetitions | 23.9 → 39.4 | 29.0 → 29.5 |

All literal-writing trials passed, but the tasks are small. Some individual
file/shell trials were slower, and coordination paid extra discovery/code costs.

## Separately held-out real repository change

After the six-task comparison, the interface was checked on the actual output-excerpt
change, using source from `bee8ce2e5c2f0864d63c058e2361f6b7c6dce36d^` and the existing
tests from that commit. The task required editing only the real extension module,
preserving its other behavior and passing its existing tests. No interface tuning
was performed to this task.

One graded trial per model/arm completed:

| Model | Interface | Success | New input | Cached input | Output | Calls | Seconds |
|---|---|---:|---:|---:|---:|---:|---:|
| Opus 5.5 | Current | 1/1 | 34,132 | 202,030 | 13,371 | 8 | 130.3 |
| Opus 5.5 | Single | 1/1 | 29,688 | 156,827 | 14,226 | 10 | 141.9 |
| GPT 6 Sol | Current | 1/1 | 20,677 | 228,096 | 4,839 | 15 | 106.1 |
| GPT 6 Sol | Single | 1/1 | 35,951 | 394,752 | 6,350 | 18 | 140.3 |

The single interface was **8.9% slower on Opus and 32.2% slower on GPT**. GPT's
input cost also increased. The single runs included a GPT script syntax error and
an Opus attempt to use `process` inside the sandbox. Models recovered, but those
costs are part of the result, not removed as outliers.

The held-out run was stopped during the second repetition. Three workers were
interrupted. One more baseline GPT worker had completed but had not been graded;
its existing measurements are retained separately as `unscoredHeldOut`, not counted
as a success or mixed into the balanced table. There were no further measurement
runs. The earlier setup pilots are excluded: the first lacked the named built-ins;
the second had a misplaced catalog-observation hook. The final runner asserts the
provider-visible tool set after Pi's hidden-declaration projection.

## Interpretation and limits

52 graded trials passed, but the slower real-code results matter more than claiming
a universal win from small tasks. The evidence supports a compact fixed discovery
interface and dataflow batching; it does **not** establish script-only file/shell
work as the best default. A future candidate could keep one model-facing tool but
add a structured primitive/batch path for routine coding calls, retaining scripts
for loops and classification. That alternative has not been measured here.

Correctness follow-ups for child-interface inheritance, late MCP discovery and
terminal handoff were covered by deterministic integration tests after the measured
runs; they were not re-benchmarked. A new native session verifies one declaration,
guard/approval behavior, individual nested events, structured data and output spills.
Full browser interaction, live remote-agent approval and Windows execution were not
part of the benchmark.

## Reproduction

Run from the repository root with the pinned dependencies and already-configured
Pi provider credentials. Output belongs outside the checkout:

```sh
env -u PI_DESK_RUNTIME node pi-improve-skill/bench/single-tool/run.mjs \
  --out /tmp/single-tool-workflows --repeats 2 --jobs 4 \
  --cases repair,literal,shell-data,agent-route,work-cards,classify-act
```

The separate real-repository case is selected with `--cases repo-excerpt`; it needs
the referenced Git history. Existing `done.json` files are resumed, not regenerated.
The benchmark itself is not part of the ordinary test suite.
