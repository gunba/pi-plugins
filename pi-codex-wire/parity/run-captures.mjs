import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startCapture } from "./capture-server.mjs";

const [binary, catalogPath, outputPath, version] = process.argv.slice(2);
if (!version) throw new Error("Usage: node run-captures.mjs <codex-binary> <models.json> <output-directory> <version>");
const output = resolve(outputPath);
mkdirSync(output, { recursive: true });
const scratch = mkdtempSync(join(tmpdir(), "codex-wire-capture-"));
const keyPath = join(scratch, "key.pem"), certPath = join(scratch, "cert.pem");
execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPath, "-out", certPath, "-days", "1", "-subj", "/CN=chatgpt.com"], { stdio: "ignore" });
const key = readFileSync(keyPath), cert = readFileSync(certPath);
const bundled = JSON.parse(readFileSync(catalogPath, "utf8"));
const template = bundled.models.find(model => model.slug === "gpt-6-astra");
if (!template) throw new Error("Catalog must contain gpt-6-astra");
const extension = fileURLToPath(new URL("../extensions/index.ts", import.meta.url));

function run(command, args, env, cwd, prefix) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { env, cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    const timer = setTimeout(() => child.kill("SIGTERM"), 60_000);
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      writeFileSync(prefix + ".stdout", stdout);
      writeFileSync(prefix + ".stderr", stderr);
      resolveRun({ code, signal });
    });
  });
}

async function capture(client, lite, scenario) {
  const name = `${client}-${lite ? "lite" : "standard"}-${scenario}`;
  const sse = scenario.endsWith("-sse");
  const behavior = scenario.replace(/-sse$/, "");
  const home = join(scratch, name);
  mkdirSync(home);
  const catalog = { models: [{ ...template, use_responses_lite: lite, tool_mode: "direct", multi_agent_version: null,
    guardian: null, model_messages: { instructions_template: "You are Codex." }, experimental_supported_tools: [] }] };
  const log = join(output, name + ".jsonl");
  writeFileSync(log, "");
  const server = await startCapture({ catalog, log, key, cert, scenario: behavior, sse });
  const env = { PATH: process.env.PATH, HOME: home, LANG: "C.UTF-8", TERM: "dumb", NO_PROXY: "127.0.0.1,localhost" };
  let command, args;
  const prompt = "Run printf parity once with the shell tool, then reply parity.";
  if (client === "native") {
    command = resolve(binary);
    const nativeCatalog = join(home, "models.json");
    writeFileSync(nativeCatalog, JSON.stringify(catalog));
    writeFileSync(join(home, "config.toml"), `openai_base_url = ${JSON.stringify(server.url + "/v1")}\nmodel = "gpt-6-astra"\nmodel_catalog_json = ${JSON.stringify(nativeCatalog)}\nmodel_reasoning_effort = "medium"\nmodel_reasoning_summary = "auto"\n[analytics]\nenabled = false\n`);
    env.CODEX_HOME = home;
    env.CODEX_API_KEY = "dummy-key";
    args = ["exec", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", "--json", prompt];
  } else {
    command = "pi";
    env.PI_CODING_AGENT_DIR = home;
    env.PI_OFFLINE = "1";
    env.HTTPS_PROXY = server.url;
    env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    const access = `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "capture-account" } })).toString("base64url")}.x`;
    writeFileSync(join(home, "auth.json"), JSON.stringify({ "openai-codex": { type: "oauth", access, refresh: "capture-refresh", expires: Date.now() + 86_400_000, accountId: "capture-account" } }));
    args = ["-p", ...(behavior === "missing-ids" ? ["--session-id", randomUUID()] : ["--no-session"]),
      "--mode", "json", "--no-extensions", "--no-mcp", "--no-skills", "--no-context-files", "-e", extension,
      "--provider", "openai-codex", "--model", "gpt-6-astra", "--thinking", "medium", "--tools", "bash", "--system-prompt", "You are Codex.",
      "--codex-wire-version", version, "--codex-wire-client", "cli", "--codex-wire-compression", "off", "--codex-wire-prewarm", "on",
      "--codex-wire-transport", sse ? "sse" : "auto", prompt];
  }
  try {
    const result = await run(command, args, env, home, join(output, name));
    let resume;
    if (behavior === "missing-ids" && result.code === 0) {
      const resumeArgs = client === "native" ? [...args.slice(0, -1), "resume", "--last", "Reply parity again."]
        : [...args.slice(0, -1), "Reply parity again."];
      resume = await run(command, resumeArgs, env, home, join(output, name + ".resume"));
    }
    const requests = server.records.filter(record => record.kind === "websocket" || record.kind === "http" && record.method === "POST");
    const summary = { name, ...result, resume, requests: requests.length,
      prewarms: requests.filter(record => record.body?.generate === false).length,
      continuations: requests.filter(record => record.body?.previous_response_id).length };
    console.log(JSON.stringify(summary));
    return summary;
  } finally { await server.close(); }
}

// Each lane has isolated credentials, ports, and histories; lanes share no mutable fixtures.
const summaries = (await Promise.all([false, true].flatMap(lite => ["native", "wire"].map(async client => {
  const results = [];
  for (const scenario of ["tool", "missing-ids", "model-not-found", "missing-ids-sse", "model-not-found-sse"]) results.push(await capture(client, lite, scenario));
  return results;
})))).flat();
writeFileSync(join(output, "summary.json"), JSON.stringify({ scratch, summaries }, null, 2) + "\n");
