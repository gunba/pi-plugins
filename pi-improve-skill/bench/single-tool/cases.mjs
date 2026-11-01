import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const text = (root, path) => readFile(join(root, path), "utf8");
const json = async (root, path) => JSON.parse(await text(root, path));
const put = async (root, path, content) => { await mkdir(join(root, path, ".."), { recursive: true }); await writeFile(join(root, path), content); };
const tickets = [
  ["outage", "All customers cannot log in. Production has been completely down for 30 minutes. This needs immediate action.", true],
  ["colour", "Could we eventually add a blue theme? This is cosmetic and not urgent.", false],
  ["leak", "The public API is leaking private customer records right now. Urgent security incident: stop exposure immediately.", true],
  ["docs", "There is a minor spelling mistake in an old documentation example. Fix whenever convenient.", false],
  ["billing", "Customers are being charged ten times for every purchase in production right now. Stop the duplicate charges immediately.", true],
  ["idea", "Feature idea for next year: optional keyboard themes. No current customers are affected.", false],
];

const sourceRoot = fileURLToPath(new URL("../../../", import.meta.url));
const excerptCommit = "bee8ce2e5c2f0864d63c058e2361f6b7c6dce36d";
const gitFile = (revision, path) => execFileSync("git", ["show", `${revision}:${path}`], {cwd:sourceRoot,encoding:"utf8"});
const excerptFiles = () => execFileSync("git", ["ls-tree", "-r", "--name-only", `${excerptCommit}^`, "pi-output-budget/extensions", "pi-context-window/prompt-cache.ts"], {cwd:sourceRoot,encoding:"utf8"}).trim().split("\n");

export const cases = [
  { id: "repair", group: "files-shell", prompt: "Fix normalizeTags in src/tags.mjs. It must trim strings, lowercase, remove empty tags and deduplicate while preserving first occurrence. Null, nonarrays and nonstring elements must be ignored. Read README.md, make a targeted edit (not a whole-file rewrite), and run the existing tests. Do not change tests.",
    async setup(root) {
      await put(root, "README.md", "Use read for files, edit for targeted changes, and bash for checks. No dependencies are needed.\n");
      await put(root, "src/tags.mjs", 'export function normalizeTags(input) {\n  return input.map(tag => tag.toLowerCase());\n}\n');
      await put(root, "tests/tags.test.mjs", 'import assert from "node:assert/strict";\nimport {normalizeTags} from "../src/tags.mjs";\nassert.deepEqual(normalizeTags([" A ","b","a","",null,4]), ["a","b"]);\nassert.deepEqual(normalizeTags(null), []);\nassert.deepEqual(normalizeTags("x"), []);\n');
    },
    async score(root, trace) {
      execFileSync(process.execPath, ["--test", "tests/tags.test.mjs"], { cwd: root, stdio: "pipe" });
      assert.ok(trace.some(e => e.tool === "edit"));
      assert.ok(trace.some(e => e.tool === "bash" && /test/.test(e.args.command)));
      const probe = 'import {normalizeTags as n} from "./src/tags.mjs"; import a from "node:assert/strict"; a.deepEqual(n([" Q ", {}, false, "q", "R", " "]), ["q","r"]); a.deepEqual(n({}), []);';
      execFileSync(process.execPath, ["--input-type=module", "-e", probe], { cwd: root, stdio: "pipe" });
    } },
  { id: "literal", group: "files-shell", prompt: "Read template.txt and create fixture.mjs using write. It must export a named constant template whose value is exactly the entire contents of template.txt, including all whitespace, backslashes, backticks and ${...} text. The module must be self-contained: no imports, file reads or runtime decoding. Verify exact equality with Node. Do not change template.txt.",
    async setup(root) {
      await put(root, "template.txt", Array.from({length: 100}, (_, i) => `row ${i}: const x = \`literal \${value_${i}}\`; regex /\\w+\\n/g; "quoted" 'single' C:\\tmp\\file\n`).join(""));
    },
    async score(root, trace) {
      const source = await text(root, "fixture.mjs");
      assert.ok(!/\bimport\b|readFile|atob|Buffer\.from/.test(source));
      execFileSync(process.execPath, ["--input-type=module", "-e", 'import {template} from "./fixture.mjs"; import {readFileSync} from "node:fs"; import assert from "node:assert/strict"; assert.equal(template, readFileSync("template.txt", "utf8"));'], { cwd: root, stdio: "pipe" });
      assert.ok(trace.some(e => e.tool === "write" && e.args.path.endsWith("fixture.mjs")));
    } },
  { id: "shell-data", group: "files-shell", prompt: "events.ndjson contains production events. Compute, per service, the count and sum of duration for records with status >= 500. Write summary.json as an object keyed by service, each value {count,totalDuration}. Use bash for data processing and verification. Do not print or return the whole input: only the summary and any errors.",
    async setup(root) { await put(root, "events.ndjson", Array.from({length: 12000}, (_, i) => JSON.stringify({service: ["api","web","jobs"][i % 3], status: i % 7 === 0 ? 503 : 200, duration: i % 97})).join("\n")); },
    async score(root, trace) {
      const expected = {api:{count:572,totalDuration:27442},web:{count:572,totalDuration:27372},jobs:{count:571,totalDuration:27325}};
      assert.deepEqual(await json(root, "summary.json"), expected);
      assert.ok(trace.some(e => e.tool === "bash"));
    } },
  { id: "agent-route", group: "coordination", prompt: "Use agent_list to find the running primary agents working in /workspace/api (not its similarly named sibling /workspace/api-old; not idle or closed agents). Send each exactly one message: 'Please review the API boundary changes.' Do not start, stop or message other agents. Write routed.json containing only the sorted recipient IDs. The agent backend in this benchmark is an isolated fixture; use the actual agent tools.",
    async setup() {},
    async score(root) {
      assert.deepEqual(await json(root, "routed.json"), ["api-a", "api-b"]);
      const sent = (await text(root, "sent.jsonl")).trim().split("\n").map(JSON.parse).sort((a,b) => a.to.localeCompare(b.to));
      assert.deepEqual(sent, [{to:"api-a",message:"Please review the API boundary changes."},{to:"api-b",message:"Please review the API boundary changes."}]);
    } },
  { id: "work-cards", group: "coordination", prompt: "Create a manual plan to prepare a status note, with one step. Write status.md containing 'Ready for review.\\n' (a real newline), show it with show, mark the step completed and complete the plan. Start a time watch for 2099-01-01T09:00:00Z, then stop that exact watch before finishing. Use the plan, show and watch operations, not substitutes.",
    async setup() {},
    async score(root, trace) {
      assert.equal(await text(root, "status.md"), "Ready for review.\n");
      for (const name of ["create_plan", "show"]) assert.ok(trace.some(e => e.tool === name));
      assert.ok(trace.some(e => e.tool === "update_plan" && e.args.action === "complete"));
      assert.ok(trace.some(e => e.tool === "watch" && e.args.until));
      assert.ok(trace.some(e => e.tool === "watch" && e.args.stop));
      const done = await json(root, "control-state.json");
      assert.equal(done.phase, "complete"); assert.equal(done.watches, 0);
    } },
  { id: "repo-excerpt", group: "held-out", prompt: "This is a source snapshot of gunba/pi-plugins before its long-output excerpt change. Implement that change in pi-output-budget/extensions/index.ts only. For a result over Pi's limits (2000 lines or 50 KB), save the whole output and send a header giving its length and full file path, followed by at most 40 lines and 3000 UTF-8 bytes: the tail for bash/PowerShell, the head for other tools. For native tools that already spilled output, retain the complete spill in ArtifactStore and excerpt that saved whole. Preserve image attachments, native details, errors, usage and the outputBudgeted guard. read must retain its existing 2000-line paging behavior. Read the relevant files and run the existing pi-output-budget/tests/tools.test.mjs tests. Do not change tests or other source files; node_modules is already supplied. Do not look up the reference implementation in another checkout or online.",
    async setup(root) {
      await put(root, "package.json", '{"type":"module"}\n');
      for (const path of excerptFiles()) await put(root, path, gitFile(`${excerptCommit}^`, path));
      await put(root, "pi-output-budget/tests/tools.test.mjs", gitFile(excerptCommit, "pi-output-budget/tests/tools.test.mjs"));
      await symlink(join(sourceRoot,"node_modules"), join(root,"node_modules"), "junction");
    },
    async score(root, trace) {
      assert.equal(await text(root,"pi-output-budget/tests/tools.test.mjs"), gitFile(excerptCommit,"pi-output-budget/tests/tools.test.mjs"));
      for (const path of excerptFiles().filter(path => path !== "pi-output-budget/extensions/index.ts")) assert.equal(await text(root,path),gitFile(`${excerptCommit}^`,path));
      execFileSync(process.execPath,["--test","pi-output-budget/tests/tools.test.mjs"],{cwd:root,stdio:"pipe"});
      assert.ok(trace.some(e=>e.tool === "bash" && /--test/.test(e.args.command)));
    } },
  { id: "classify-act", group: "dataflow", prompt: "tickets/ contains six text files. In a single codemode call, read the files, classify EACH with the real models.classify using typesafe/jev-latest (a boolean question: does this require immediate action for a live production incident?), and use the returned probability >= 0.8 to decide which to include. Within that same call write urgent.json as a sorted array of matching file basenames without .txt. Use a loop or Promise.all, do not substitute your own classification, and do not print ticket contents or complete classifier responses. You may read the codemode docs before that call. Paths: tickets/outage.txt, tickets/colour.txt, tickets/leak.txt, tickets/docs.txt, tickets/billing.txt, tickets/idea.txt.",
    async setup(root) { for (const [id, content] of tickets) await put(root, `tickets/${id}.txt`, content); },
    async score(root, trace) {
      assert.deepEqual(await json(root, "urgent.json"), ["billing", "leak", "outage"]);
      const call = trace.find(e => e.tool === "codemode" && /models\.classify/.test(e.args.code));
      assert.ok(call, "must use the real classifier API");
      const children = trace.filter(e => e.parent === call.id);
      assert.equal(children.filter(e => e.tool === "read" && /tickets/.test(e.args.path)).length, 6);
      assert.ok(children.some(e => e.tool === "write" && e.args.path.endsWith("urgent.json")));
    } },
];
