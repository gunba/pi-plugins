# Mining pipeline

Builds the review corpus behind the `test-writing` and `code-comments`
skills. Raw data and intermediate files go to `~/.cache/pi-code-craft`
(override with `CRAFT_CORPUS_DIR`); changes already fetched for the
code-review corpus in `~/.cache/pi-code-review` are reused, not fetched again.
Node 22.19+, `gh` signed in, and git.

| Step | Command | Output |
|---|---|---|
| GitHub PRs | `node github.mjs [--review 350] [--added 250] [--agents 250] [--only review\|added\|agents]` | `github/<repo>/<n>.json`, agent lists in `github/_agents/` |
| Mailing lists | `node lore.mjs [--per-list 400] [list ...]` | `lore/<list>/<n>.json` |
| Gerrit | `node gerrit.mjs [--per-project 300]` | `gerrit/<project>/<n>.json` |
| Review units | `node normalize.mjs` | `units.jsonl`, `changes.jsonl` |
| Jev, first pass | `node prepare.mjs`, then `classify.codemode.js` with `NAME=""`, `QUESTIONS="questions.json"` | `jev/out/` |
| Jev, problems | `node prepare.mjs --ids <ids> --name tests` (and `comments`, `rebuttal`), then codemode with that `NAME` and `test-moves.json`, `comment-moves.json` or `rebuttal.json` | `jev/<name>-out/` |
| Pools and stats | `node build.mjs` | `../skills/*/references/*.jsonl`, `labelled.jsonl`, `stats.json` |

Sources are in `config.mjs`. `github.mjs` samples three groups: more changes
from the code-review projects, projects known for their test suites, and
changes written by coding agents (Copilot's coding agent by account; Claude
Code and Codex by the signature they leave in the description). The id lists
for the second Jev pass come from the first pass: people's remarks Jev marked
as about test code or coverage, about code comments, and rejected remarks with
an author reply.

Jev is reached through the pi session's `models.classify`. `classify.codemode.js`
reads one chunk per call, classifies four units at a time, writes results and
deletes the chunk, so rerunning it resumes. Codemode runs two scripts at once;
set `PART` and `PARTS` to split a queue between them. Two runs label about 27
units a second. The labelling only runs while a session is running the script.

`build.mjs` splits changes 85/15 into train and holdout by the same hash as
the code-review corpus. The skills' figures and examples use only the training
split.
