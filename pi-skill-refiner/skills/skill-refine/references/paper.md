# Paper contract

## Primary sources

- Anirudh Khatry, Calvin Smith, Greg Durrett, Isil Dillig and Graham Neubig,
  **SkillRefiner: Offline Skill Refinement from Historical Agent Traces**,
  [primary PDF, v1](https://pdfs.assets.alphaxiv.org/2610.skillrefiner-offline-skill-refinementv1.pdf).
  The supplied [alphaXiv viewer](https://www.alphaxiv.org/pdf/2610.skillrefiner-offline-skill-refinement)
  serves an HTML viewer pointing to that PDF, not an arXiv numeric identifier.
- [Authors' implementation, inspected revision
  `d9dfdb8e7e73e2449a7af1e04bd78ecb366db1db`](https://github.com/OpenHands/SkillRefiner/tree/d9dfdb8e7e73e2449a7af1e04bd78ecb366db1db),
  linked from the paper's first page. See
  [clustering](https://github.com/OpenHands/SkillRefiner/blob/d9dfdb8e7e73e2449a7af1e04bd78ecb366db1db/skill_refiner/cluster/umap_hdbscan.py)
  and [numeric dependency pins](https://github.com/OpenHands/SkillRefiner/blob/d9dfdb8e7e73e2449a7af1e04bd78ecb366db1db/pyproject.toml).

## Actual method

Section 2, pp. 3–5, starts from an initial skill and historical executions with
binary observed outcomes and optional evaluator feedback. It generates no fresh
task rollouts during refinement.

1. Attach available grader evidence to failures, then summarize context, strategy,
   salient actions and outcome.
2. Embed summaries and cluster successful and failed runs **independently**.
   Singleton/noise points do not independently induce refinements.
3. Generate **one edit per cluster**. Success clusters reinforce repeated effective
   behaviors; failure clusters localize a recurring problem and elicit a remedy
   from the LLM's prior knowledge.
4. A separate LLM call judges the fixed failure proposal against its supporting
   summaries. It checks recurrence and a plausible connection to observed failure,
   not whether the proposed repair would actually succeed. It does not revise it.
5. Merge positive and supported negative proposals with the original skill.
   Restrict conflicting behaviors in their failure contexts rather than banning
   useful behavior everywhere; preserve unrelated guidance.

Appendix A.2, p. 14, uses local Ollama `qwen3-embedding:4b`, L2 normalization,
UMAP cosine distance (20 components, 15 neighbors, minimum distance 0.1), then
HDBSCAN Euclidean distance (minimum cluster size 2, minimum samples 1,
excess-of-mass selection). Appendix A.5, pp. 16–19, supplies the stage prompts.
The inspected implementation uses random seed 42 and caps UMAP dimensions and
neighbors for smaller partitions.

## Evidence and limits

Section 3 evaluates spreadsheet manipulation, mathematical reasoning and production
PR review, using disjoint final evaluation data. The PR label comes from later
developer changes; Appendix A.1 documents a threshold for matching suggestions.
That is task-specific supervision, not a universal rule for labeling Pi sessions.

Sections 4 and A.4 report improvements across eight settings and 1.4–42× fewer
refinement tokens across the compared baselines. These counts exclude collecting
historical traces. They do not establish total cost, latency, compute savings or
performance on arbitrary skills. GEPA receives a fixed budget of five candidate
revisions in this comparison, not an unlimited or universally optimal search.
PR-review F1 uses an LLM matching judge and is a proxy for usefulness.

Failure remedies remain hypotheses (Section 2.4). Summaries, labels, embeddings,
clusters and evidence judgments can all be wrong. Recurring behavior is not causal
proof, and no offline gate measures the counterfactual effect of an edit.

## Pi adaptation

This plugin implements the five-stage structure and the numeric clustering
configuration, but is not a benchmark reproduction or a wrapper of the complete
OpenHands package. Its prompts are adapted for procedural skills and entry-linked
Pi evidence; generative stages use the active native Pi model, not fixed benchmark
models. It refines one `SKILL.md`, not supporting scripts or a whole skill library.

Embeddings use [DeepInfra's hosted `Qwen/Qwen3-Embedding-4B`](https://deepinfra.com/Qwen/Qwen3-Embedding-4B/api),
not the paper's local Ollama deployment. L2 normalization and UMAP/HDBSCAN remain
local with the same configuration. The API model identifier is recorded, but the
provider does not supply a pinned weight digest; hosting, precision and model
updates can change numerical results. Summaries and observations are sent to
DeepInfra, while trace summarization and all edit reasoning use the active Pi
model. Embedding tokens and estimated cost are recorded separately from Pi usage.

The query-first front end is additional: bounded local lexical retrieval,
branch/fork deduplication, and LLM extraction of outcomes backed by exact quotes.
The paper assumes labels already exist. Unknown outcomes are excluded rather than
turning normal assistant completion into success. Current target text is pinned,
but historical traces do not prove that this exact skill version was loaded.

Large traces use chunked summaries followed by one reconciliation. Small partitions
with fewer than three labeled traces become noise rather than provoking UMAP's
small-sample error. Other small partitions use the upstream dimension/neighbor
caps. Fixed-seed UMAP runs one numerical thread per partition; the independent
outcome partitions run concurrently, and HDBSCAN can use available CPU cores.

No final held-out tasks are run, no expected improvement is measured, and no
candidate is automatically installed. Exact hashes, source quotes and full local
stage artifacts make the proposal reviewable, not experimentally validated.

## GEPA distinction

The repository's `pi-gepa` uses the actual GEPA optimizer: training feedback drives
reflection, validation drives candidate selection, and an independent holdout is
opened only after selection. A deterministic evaluator can score text without an
autonomous agent, so “GEPA always needs agent rollouts” is too broad outside this
paper's agent-skill experiment. It still needs new candidate evaluations.

SkillRefiner instead compiles recurring historical patterns into one proposed
revision. It has no candidate-search population, selection evaluator or new task
execution. It is useful where replay is unavailable or outcomes arrive late;
GEPA can test candidates where an evaluator is available. A combined workflow is
possible, but neither the paper nor this integration establishes additive gains.
