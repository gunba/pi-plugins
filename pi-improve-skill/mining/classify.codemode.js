// @options: {"timeout_ms": 1500000}
// Runs inside pi's codemode tool (Jev is reached through the session's
// `models.classify`; there is no standalone key). Paste this file as the
// codemode script after setting CORPUS, NAME and QUESTIONS (a file in the
// corpus's folder, or rebuttal.json beside this script):
//   code-review: NAME ""          jev/in/          -> jev/out/           questions.json
//                NAME "moves"     jev/moves-in/    -> jev/moves-out/     moves.json
//   code-craft:  NAME ""          jev/in/          -> jev/out/           questions.json
//                NAME "tests"     jev/tests-in/    -> jev/tests-out/     test-moves.json
//                NAME "comments"  jev/comments-in/ -> jev/comments-out/  comment-moves.json
//                NAME "rebuttal"  jev/rebuttal-in/ -> jev/rebuttal-out/  rebuttal.json
// Each input chunk is deleted once its results are written, so rerunning the
// script resumes a stopped run; it stops by itself after BUDGET_MS. Chunks
// stay under 110 KB because read(full) returns at most 128 KB. Several copies
// can run at once on disjoint chunks: set PART to 0..PARTS-1 in each.
const CORPUS = "code-craft";
const NAME = "";
const QUESTIONS = "questions.json";
const BUDGET_MS = 22 * 60 * 1000;
const PART = 0, PARTS = 1;
// This folder in the pi-plugins checkout, and the corpus's data folder (its config.mjs DATA_DIR).
const MINING = "/home/jordan/Desktop/Projects/pi-plugins/pi-improve-skill/mining";
const BASE = `/home/jordan/.cache/pi-${CORPUS}/jev`;

const started = Date.now();
const jev = { provider: "typesafe", id: "jev-latest" };
const inDir = `${BASE}/${NAME ? `${NAME}-in` : "in"}`;
const outDir = `${BASE}/${NAME ? `${NAME}-out` : "out"}`;
const questions = JSON.parse(await tools.read({ path: QUESTIONS === "rebuttal.json" ? `${MINING}/rebuttal.json` : `${MINING}/${CORPUS}/${QUESTIONS}`, full: true }));
await tools.bash({ command: `mkdir -p ${outDir}`, timeout: 10 });
const stamp = Date.now().toString(36);
const todo = (await tools.bash({ command: `cd ${inDir} && ls`, timeout: 30 })).output.trim().split("\n").filter(Boolean)
  .filter(f => parseInt(f, 10) % PARTS === PART);
const r2 = x => Math.round(x * 100) / 100;
let units = 0, errors = 0, lastError = null, chunks = 0;
for (const file of todo) {
  if (Date.now() - started > BUDGET_MS) break;
  const rows = (await tools.read({ path: `${inDir}/${file}`, full: true })).trim().split("\n").map(l => JSON.parse(l));
  const out = await Promise.all(rows.map(async row => {
    let res = await models.classify(jev, { state: row.state, questions });
    if (res.stopReason !== "stop") res = await models.classify(jev, { state: row.state, questions });
    if (res.stopReason !== "stop") { errors++; lastError = res.errorMessage; return null; }
    const o = { id: row.id };
    for (const [k, v] of Object.entries(res.answers)) {
      if (v.type === "choice") {
        o[k] = v.choice;
        o[`${k}_p`] = Object.fromEntries(Object.entries(v.probabilities).filter(([, p]) => p >= 0.01).map(([c, p]) => [c, r2(p)]));
      } else if (v.type === "score") o[k] = r2(v.score);
      else o[k] = r2(v.probability);
    }
    return o;
  }));
  await tools.write({ path: `${outDir}/${stamp}-${file}`, content: out.filter(Boolean).map(o => JSON.stringify(o)).join("\n") + "\n" });
  await tools.bash({ command: `rm ${inDir}/${file}`, timeout: 10 });
  units += rows.length;
  chunks++;
}
return { units, chunks, left: todo.length - chunks, errors, lastError, minutes: Math.round((Date.now() - started) / 600) / 100 };
