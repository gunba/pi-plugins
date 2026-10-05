# Skill Refiner

Improve a skill from relevant saved Pi sessions. The plugin finds evidence locally,
uses the current Pi model to propose changes, and writes a candidate and diff for
review. It never changes an installed skill.

```text
/skill-refine improve my spreadsheet skill's formula verification
```

The command delegates to `skill_refine`, also available through codemode and the
`skill-refine` skill. It resolves the named skill from Pi's loaded skills. An
ambiguous target requires a name or `skillPath`; session files do not need to be
chosen by hand.

Requires Pi 1.0, Node 22.19+, and the local clustering setup below. Loading the
extension does not read histories, call models, or start services.

## Setup

Generative stages use Pi's active chat model, thinking level, provider integration
and authentication through `ctx.modelRegistry.streamSimple()`. They have no tools
and do not inherit the current conversation. The plugin does not choose another
chat model or change model settings. Virtual-model routing is not implemented by
this nested-call adapter; use a physical model selected in Pi.

Embeddings use [DeepInfra's Qwen3 Embedding 4B API](https://deepinfra.com/Qwen/Qwen3-Embedding-4B/api).
Set `DEEPINFRA_API_KEY` in the environment of the Pi process. This is a separate
DeepInfra credential; Pi's ChatGPT authentication is used only for generative
stages. The plugin reads the key from the environment and does not store it in run
artifacts or accept it as a tool argument.

No Ollama, local embedding model or GPU is needed. UMAP and HDBSCAN still run
locally. On first use, the skill guides the agent to prepare a private Python 3.13
environment and install the pinned numeric stack. It includes Linux/macOS and
Windows instructions and reuses the environment afterward. Missing Python itself
or API credentials are reported as separate setup decisions.

For manual preparation, the equivalent Linux/macOS commands are:

```sh
python3.13 -m venv ~/.pi/skill-refiner-env
~/.pi/skill-refiner-env/bin/python -m pip install -r /path/to/pi-plugins/pi-skill-refiner/requirements.txt
```

Pass the environment's Python as `pythonPath` to the tool; on Windows use
`Scripts/python.exe`. This works immediately without changing the running Pi
process's environment. `PI_SKILL_REFINER_PYTHON` remains an optional process-level
default. The extension itself never installs dependencies on load or starts
services; setup is performed by the agent following the skill instructions.
Embedding requests use the fixed HTTPS endpoint
`https://api.deepinfra.com/v1/openai/embeddings`; redirects are refused.

Check readiness without reading sessions or generating text:

```js
await tools.skill_refine({
  query: "spreadsheet skill",
  mode: "preflight",
  pythonPath: "/absolute/path/to/skill-refiner-env/bin/python"
});
```

Preflight verifies exact Python dependency versions and that an API key is
configured. It makes no network requests and cannot validate the key, provider
quota or model availability. A normal refinement preflights before retrieving
histories; authentication is checked by the first actual embedding request.

DeepInfra currently lists this model at **US$0.02 per million input tokens**:
40 summaries of 500 tokens each cost about **$0.0004** to embed. This is separate
from native Pi generation usage. `clusters.json` records reported embedding input
tokens and an estimate at that reference rate; the provider's current pricing and
bill are authoritative. Missing usage remains unknown, not zero. Failed or
cancelled runs may incur charges before a final usage artifact is written.

## Scope and retrieval

An explicit refinement request authorizes retrieval within the requested scope.
The default is the current workspace's native saved-session directory and matching
session `cwd`; the active session file is excluded. For another archive, supply
`sessionRoot`. Set `allWorkspaces: true` only when the request calls for a wider
search; without an explicit root this selects `getAgentDir()/sessions`.

```js
await tools.skill_refine({
  query: "Improve spreadsheet formula verification from previous work",
  skillPath: "/private/skills/spreadsheet/SKILL.md",
  mode: "preview"
});
```

Preview resolves the target and retrieves locally, with no model or embedding
calls and no run directory. It reports selected paths, saved branch tips and scan
exclusions, not whole transcripts.

Retrieval is a bounded lexical scan, not a semantic database. It ranks query terms,
skill metadata, and exact skill-read/command references. It reads at most 500 recent
JSONL files and 128 MiB per invocation, skips files above 32 MiB, and descends two
directory levels without following symlinks. Default selection is 40 traces
(`maxTraces`, up to 120). Vocabulary mismatch, older evidence and scope boundaries
can hide relevant sessions; preview makes the selection inspectable.

Only complete native v3 session files are accepted. Each saved terminal branch is
reconstructed through `parentId`, rather than treating physical file order as one
conversation. Branch-relative context edits are honored. Raw pre-compaction
messages remain available, but compaction/abandoned-branch summaries, system
prompts, extension state, reasoning, images and opaque signatures are excluded.
No linked artifact or parent-session path is opened automatically. At most one
branch per known fork lineage is selected; duplicate content is also excluded.
These conservative exclusions avoid treating alternative histories as repeated
independent success/failure. They can omit useful evidence from long-lived sessions.

Selected text and tool arguments/results are sent to the active Pi provider during
refinement; summaries and their observations also reach DeepInfra. This is **offline task refinement**,
not necessarily network-free inference. There is no general secret scrubber.
Choose scope accordingly. Native histories are read-only and never migrated.

## Refinement and review

The pipeline follows [SkillRefiner](skills/skill-refine/references/paper.md):

1. Extract observed task outcomes and summarize each retrieved execution. User or
   evaluator/tool evidence must have exact entry-linked quotes. Unsupported,
   unresolved and mixed outcomes stay unknown and do not induce edits.
2. Embed summaries and cluster successes and failures separately. Noise does not
   produce proposals. Partitions with fewer than three outcomes remain noise.
3. Propose one targeted edit per recurring cluster.
4. Judge each failure-derived proposal against its fixed supporting summaries in
   a separate call. The gate does not rewrite or replay it.
5. Merge success proposals and supported failure proposals, qualifying conflicting
   rules at their source. Preserve skill frontmatter and unrelated guidance.

Outcome extraction is an adaptation: the paper starts with externally observed
labels and optional grader feedback. An LLM's interpretation of session evidence
is less reliable. Historical use of the current skill version is not established.
A verified quote proves provenance, not a diagnosis or remedy's correctness.

Runs default to `~/.pi/agent/skill-refiner-runs/run-*` (respecting
`PI_CODING_AGENT_DIR`). Override with `PI_SKILL_REFINER_RUNS` or `runRoot`. Run
roots inside Git working trees are rejected; new directories/files request private
Unix permissions. Protect the directory with suitable ACLs on Windows.

- `source.SKILL.md`: pinned starting text.
- `retrieval.json`: selected branch/entry evidence, source hashes and exclusions.
- `summaries.json`, `clusters.json`: outcomes, citations, embeddings, provider/model,
  embedding token usage and cost estimate, numeric versions, assignments and noise.
- `proposals.jsonl`: proposed edits, source trace IDs, accepted/rejected gates.
- `calls.jsonl`: bounded-model request/response audit and usage.
- `candidate.SKILL.md`, `candidate.diff`, `merge.json`: proposed text, review diff,
  rationale and source/candidate hashes. Only emitted after a successful merge.
- `result.json`: model/thinking, budgets, status, elapsed time and errors.

The source hash is checked again before emitting a candidate. There is no automatic
resume, replay, measured score, Git operation, deployment, or promotion command.
A source skill may live in a local private repository via normal Pi skill loading
or `skillPath`; review and copy an accepted change there separately. Keep session
evidence and working data outside that repository. Source/candidate snapshots and
hashes support a later manual review or rollback workflow without imposing one.

Default limits are 120 generation attempts, 20 minutes, 100,000 prompt characters
per call and 8,192 output tokens. `maxCalls`, `maxSeconds` and `maxPromptChars` are
per-invocation options; generation requests also have a three-minute timeout and
no native retries. Long traces are summarized in ordered chunks, then reconciled
as one execution. Oversized proposal/merge inputs stop rather than silently dropping
evidence. Budgets bound work, not billed dollars. Reported Pi costs are catalog
estimates; DeepInfra embedding charges and local numeric compute are separate.
Embedding calls batch up to eight summaries, have a two-minute timeout and do not
retry automatically.

## Relationship to GEPA

SkillRefiner proposes a single revised skill from historical evidence, without new
task executions. GEPA searches candidates by executing an evaluator, reflecting
on training feedback and selecting on validation. The two can be composed—for
example, review an offline candidate then evaluate it in a separate GEPA run—but
that is not an algorithmic guarantee of complementarity or improvement. Use a new
independent holdout for efficacy claims; none is supplied by this plugin.
