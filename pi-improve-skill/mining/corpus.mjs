// The corpus a mining step works on, named by `--corpus <name>` (a folder beside this file) or MINING_CORPUS.
// The option is taken out of process.argv, so the steps' own arguments read as before.
const at = process.argv.indexOf("--corpus");
const name = at >= 0 ? process.argv.splice(at, 2)[1] : process.env.MINING_CORPUS;
if (!name || !/^[a-z0-9-]+$/.test(name)) throw new Error("Name the corpus: --corpus code-review or --corpus code-craft");

/** DATA_DIR: where its raw and derived data live. REUSE_DIR: another corpus's data, read instead of fetching again.
 * GITHUB, LORE, GERRIT: its sources. SAMPLE: default sample sizes. */
export const { DATA_DIR, REUSE_DIR = DATA_DIR, GITHUB = {}, LORE = {}, GERRIT = {}, SAMPLE = {} } = await import(`./${name}/config.mjs`);
export const CORPUS = name;
