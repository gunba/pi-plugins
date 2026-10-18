# Mining pipeline

Builds the review corpus behind the `code-review` skill. Raw data and
intermediate files go to `~/.cache/pi-code-review` (override with
`REVIEW_CORPUS_DIR`). Node 22.19+, `gh` signed in, and git.

| Step | Command | Output |
|---|---|---|
| GitHub PRs | `node github.mjs [--per-repo 150] [repo ...]` | `github/<repo>/<n>.json` |
| Kernel lists | `node lore.mjs [--per-list 120] [list ...]` | `lore/<list>/<n>.json` (shallow clones in `lore-git/`) |
| Go Gerrit | `node gerrit.mjs [--per-project 120]` | `gerrit/<project>/<n>.json` |
| Review units | `node normalize.mjs` | `units.jsonl`, `changes.jsonl` |
| Jev inputs | `node prepare.mjs` | `jev/in/*.jsonl` |
| Jev labels | `classify.codemode.js` in pi's codemode (`NAME=""`, `QUESTIONS="questions.json"`) | `jev/out/` |
| Review moves | `node prepare.mjs --ids <ids.json> --name moves`, then codemode with `NAME="moves"`, `QUESTIONS="moves.json"` | `jev/moves-out/` |
| Pools and stats | `node build.mjs` | `../skills/code-review/references/{exemplars,rejected}.jsonl`, `labelled.jsonl`, `stats.json` |

Repositories, lists and Gerrit projects are in `config.mjs`. Every fetch
step caches per change and resumes. The GitHub step samples half-month search
slices, so high-volume repositories are sampled across the whole window, and
it backs off on GitHub's secondary rate limits. Lore's web interface is behind
a bot challenge, so the list step reads lore's public-inbox git epochs; the
newest epoch per list is in `config.mjs` and must be bumped when lore starts a
new one.

Jev is reached through the pi session's `models.classify`; there is no
standalone key. `classify.codemode.js` reads one chunk per call (chunks stay
under 110 KB because `read` returns at most 128 KB), classifies four at a time,
writes results and deletes the chunk, so rerunning it resumes. About 15 units a
second; the full corpus takes about 40 minutes.

`build.mjs` splits changes 85/15 into train and holdout by hash. The skill's
numbers and examples use only the training split; `../bench` uses the holdout.
