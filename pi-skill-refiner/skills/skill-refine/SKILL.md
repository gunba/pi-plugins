---
name: skill-refine
description: Improve an existing skill from relevant saved Pi sessions using SkillRefiner's offline, outcome-aware refinement. Use for requests to learn recurring lessons from prior successes, failures or user corrections and propose a reviewable skill revision without replaying tasks.
---

# Skill refinement

Use `skill_refine` after an explicit improvement request. Pass the natural-language
request as `query`; let the tool resolve the target and retrieve relevant saved
sessions. Supply `skillPath` for an unlisted skill or one in a private repository.
Clarify ambiguous targets or scope, not routine session selection.

Read [the runtime contract](../../README.md) for scope and budgets. Read
[the paper contract](references/paper.md) when interpreting the method or results.

## Prepare the local runtime

Reuse a working `PI_SKILL_REFINER_PYTHON` or private environment. Otherwise, as part
of the requested refinement, create a Python 3.13 virtual environment at
`~/.pi/skill-refiner-env` and install [the pinned requirements](../../requirements.txt).
Resolve the requirements path from this skill's directory.

Linux/macOS:
```sh
python3.13 -m venv ~/.pi/skill-refiner-env
~/.pi/skill-refiner-env/bin/python -m pip install -r /absolute/plugin/path/requirements.txt
```

Windows PowerShell:
```powershell
py -3.13 -m venv "$env:USERPROFILE\.pi\skill-refiner-env"
& "$env:USERPROFILE\.pi\skill-refiner-env\Scripts\python.exe" -m pip install -r "C:\absolute\plugin\path\requirements.txt"
```

Use an existing Python 3.13 executable if it has another name. Installation of
Python itself and provisioning `DEEPINFRA_API_KEY` are separate setup decisions
when missing; surface those blockers rather than asking the user to manage an
otherwise routine private-environment installation.

Pass the environment's absolute interpreter path as `pythonPath` to preflight and
refinement calls. A shell command cannot change the running Pi process's
environment; no restart or persistent interpreter setting is needed. Run
`skill_refine` with `mode: "preflight"` before refinement, and reuse the environment
on later invocations instead of reinstalling dependencies.

## Retrieve and refine

- Keep default retrieval within the current workspace unless broader history was
  requested. `sessionRoot` selects an archive; `allWorkspaces` widens scope.
- Use `mode: "preview"` to inspect local selection without model calls, or
  `mode: "preflight"` to check Python dependencies and API-key configuration
  without reading histories or making network requests.
- Preserve the current Pi model/thinking. Embeddings use DeepInfra's hosted Qwen3
  model through `DEEPINFRA_API_KEY`; summaries and observations leave the machine.
  Do not substitute manual rewriting or LLM-only grouping if embeddings or local
  clustering are unavailable.
- Keep run data outside Git. A private skills repository can supply the target,
  but it is not the working-data directory.

Report selected evidence count, unknown/excluded outcomes, accepted and rejected
proposals, model/thinking, native usage and separate embedding usage, stop status,
and paths to `result.json` and the candidate diff. Distinguish evidence-supported hypotheses from tested gains.
Review the diff and linked citations before recommending adoption. Application,
repository creation and publication are separate actions.
