// Runs inside pi's codemode tool (Jev is reached through the session's
// `models.classify`; there is no standalone key). Paste this file as the
// codemode script after setting QUESTIONS and NAME:
//   NAME = ""       -> jev/in/*.jsonl  -> jev/out/   with questions.json
//   NAME = "moves"  -> jev/moves-in/   -> jev/moves-out/ with moves.json
// Each input chunk is deleted once its results are written, so rerunning the
// script resumes a stopped run. Chunks stay under 110 KB because read(full)
// returns at most 128 KB.
const NAME = "moves";
const QUESTIONS = "moves.json";
const MINING = "/home/jordan/Desktop/Projects/pi-plugins/pi-code-review/mining";
const BASE = "/home/jordan/.cache/pi-code-review/jev";

const jev = { provider: "typesafe", id: "jev-latest" };
const inDir = `${BASE}/${NAME ? `${NAME}-in` : "in"}`;
const outDir = `${BASE}/${NAME ? `${NAME}-out` : "out"}`;
const questions = JSON.parse(await tools.read({ path: `${MINING}/${QUESTIONS}`, full: true }));
await tools.bash({ command: `mkdir -p ${outDir}`, timeout: 10 });
const stamp = Date.now().toString(36);
const todo = (await tools.bash({ command: `cd ${inDir} && ls`, timeout: 30 })).output.trim().split("\n").filter(Boolean);
const r2 = x => Math.round(x * 100) / 100;
let units = 0, errors = 0, lastError = null;
for (const file of todo) {
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
}
return { units, errors, lastError };
