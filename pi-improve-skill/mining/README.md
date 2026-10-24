# Mining

Builds a corpus of expert review and labels it with Jev, for writing a skill and choosing its benchmark cases. Node
22.19+, `gh` signed in, and git.

Every step names its corpus with `--corpus <name>`: a folder here with `config.mjs` (its sources, sample sizes and data
folder), its Jev questions, and its `normalize.mjs`, `prepare.mjs` and `build.mjs`. The miners in `sources/` and
`classify.codemode.js` are shared. A new kind of skill gets a new corpus folder.

| Corpus | Skills | Data |
|---|---|---|
| `code-review` | `code-review` | `~/.cache/pi-code-review` (`REVIEW_CORPUS_DIR`) |
| `code-craft` | `test-writing`, `code-comments` | `~/.cache/pi-code-craft` (`CRAFT_CORPUS_DIR`); reads changes already in `code-review` instead of fetching them again |

## Steps

From this folder:

| Step | Command | Output |
|---|---|---|
| GitHub PRs | `node sources/github.mjs --corpus <c> [--<group> <n>] [--only <group>] [repo ...]` | `github/<repo>/<n>.json` |
| Mailing lists | `node sources/lore.mjs --corpus <c> [--per-list <n>] [list ...]` | `lore/<list>/<n>.json` (shallow clones in `lore-git/`) |
| Gerrit | `node sources/gerrit.mjs --corpus <c> [--per-project <n>]` | `gerrit/<project>/<n>.json` |
| Review units | `cd <c> && node normalize.mjs` | `units.jsonl`, `changes.jsonl` |
| Jev inputs | `cd <c> && node prepare.mjs` (second passes: `--ids <ids> --name <name>`) | `jev/<name>-in/` |
| Jev labels | `classify.codemode.js` in Pi's codemode, with `CORPUS`, `NAME` and `QUESTIONS` set | `jev/<name>-out/` |
| Pools and stats | `cd <c> && node build.mjs` | `~/.pi/agent/skills/<skill>/references/*.jsonl`, `labelled.jsonl`, `stats.json` |

The second Jev passes label what each remark is about: `moves.json` for `code-review`; `test-moves.json`,
`comment-moves.json` and `rebuttal.json` (why authors declined a remark) for `code-craft`. Their id lists come from the
first pass.

## Notes

- Every fetch caches per change and resumes. GitHub sampling uses half-month search slices, so busy repositories are
  sampled across the whole window, and it backs off on GitHub's rate limits. In `config.mjs`, a GitHub group is a list
  of repositories sampled with `--<group> <n>`; the `agents` group searches for changes written by coding agents
  (Copilot's coding agent by account; Claude Code and Codex by the signature they leave in the description).
- Lore's web interface is behind a bot challenge, so the list step reads lore's public-inbox git epochs. The newest
  epoch per list is in `config.mjs` and must be bumped when lore starts a new one.
- Jev is reached through the Pi session's `models.classify`; there is no standalone key. `classify.codemode.js` reads
  one chunk per call (chunks stay under 110 KB because `read` returns at most 128 KB), classifies four units at a time,
  writes results and deletes the chunk, so rerunning it resumes. Codemode runs two scripts at once; set `PART` and
  `PARTS` to split a queue. Labelling runs only while a session runs the script, at about 15 to 27 units a second.
- `build.mjs` splits changes 85/15 into train and holdout by a hash of the change, the same in both corpora. The
  skills' examples use only the training split; the benchmarks use the holdout.
