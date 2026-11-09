import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Type } from "typebox";
import { AssistantMessageEventStream, InMemoryCredentialStore, getCurrentTools } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import structuredTools from "../index.ts";
import outputBudget from "../../pi-output-budget/extensions/index.ts";
import commandGuard from "../../pi-command-guard/index.ts";
import askUser from "../../pi-ask-user/index.ts";
import plan from "../../pi-plan/extensions/plan.ts";
import show from "../../pi-show/extensions/show.ts";
import watch, { activeWatches } from "../../pi-watch/index.ts";
import { createSubagentToolDefinitions } from "../../pi-agents/subagents/subagent-tools.ts";
import { providePrimaryAgents } from "../../pi-agents/primary.ts";
import { describeAgentTools, describeSessionTools, describedTool } from "../../pi-ui/tool-descriptions.ts";
import { Transcript } from "../../pi-desk/src/host/transcript.ts";
import { TranscriptFeed } from "../../pi-desk/src/host/transcript-feed.ts";
import { visibleWorkItems } from "../../pi-desk/src/client/work-items.ts";

const model = { id: "offline", name: "offline", api: "openai-completions", provider: "fixture", baseUrl: "https://invalid.test",
  reasoning: false, input: ["text"], contextWindow: 32768, maxTokens: 2048,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

async function harness(t, extra = () => {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-request-test-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  let session;
  t.after(async () => {
    try { await session?.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); }
    finally {
      session?.dispose();
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
      await rm(root, { recursive: true, force: true });
    }
  });
  const declarations = [], events = [];
  let code, serial = 0, issued = false;
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null,
    modelsStorePath: join(root, "models.json"), allowModelNetwork: false, refreshOnCreate: false });
  const stream = (_model, context) => {
    declarations.push(getCurrentTools(context.messages));
    const result = issued
      ? { stopReason: "stop", content: [{ type: "text", text: "done" }] }
      : { stopReason: "toolUse", content: [{ type: "toolCall", id: `call-${++serial}`, name: "codemode", arguments: { code } }] };
    issued = true;
    const output = new AssistantMessageEventStream();
    queueMicrotask(() => output.push({ type: "done", reason: result.stopReason,
      message: { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), usage, ...result } }));
    return output;
  };
  runtime.registerNativeProvider({ id: model.provider, name: "fixture", auth: { apiKey: { name: "fixture", async resolve() { return { auth: { apiKey: "fixture" }, source: "fixture" }; } } }, getModels: () => [model], stream, streamSimple: stream });
  await runtime.setRuntimeApiKey(model.provider, "fixture");
  const settings = SettingsManager.inMemory({ packages: [], extensions: [], compaction: { enabled: false }, retry: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings,
    noExtensions: true, noSkills: true, noThemes: true, noContextFiles: true, noPromptTemplates: true,
    extensionFactories: [structuredTools, outputBudget, commandGuard, extra] });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  ({ session } = await createAgentSession({ cwd: root, agentDir: root, model, modelRuntime: runtime,
    sessionManager: SessionManager.inMemory(root), settingsManager: settings, resourceLoader: loader }));
  describeSessionTools(session); describeAgentTools(session.agent.state);
  await session.bindExtensions({ mode: "rpc" });
  session.subscribe(event => events.push(event));
  return { root, session, declarations, events, async run(source) {
    code = source; issued = false;
    await session.prompt("Run the request.");
    const result = session.messages.filter(message => message.role === "toolResult").at(-1);
    assert.ok(result, JSON.stringify(session.messages));
    return result;
  } };
}

/** The program's returned value: its first output; a note on failed operations may follow. */
const data = result => {
  assert.equal(result.isError, false, JSON.stringify(result.content));
  return JSON.parse(result.content[0].text);
};

test("one declaration supports ordered writes, dependent reads, loops, projections and independent errors", async t => {
  const h = await harness(t);
  const result = await h.run(`
    const writes = [];
    for (const name of ["a", "b"]) writes.push(await tools.write({path: name, content: name + "\\n"}));
    const missing = await tools.read({path: "missing"});
    const a = await tools.read({path: "a"});
    const edit = await tools.edit({path: "b", edits: [{oldText: "b", newText: "changed"}]});
    const b = await tools.read({path: "b"});
    const shell = await tools.bash({command: "printf shell"});
    return {a, b, missing: !!missing.error, shell: shell.output};`);
  assert.equal(result.isError, false, JSON.stringify(result.content));
  assert.deepEqual(data(result), { a: "a\n", b: "changed\n", missing: true, shell: "shell" });
  assert.equal(await readFile(join(h.root, "b"), "utf8"), "changed\n");
  assert.deepEqual(h.declarations.map(tools => tools.map(tool => tool.name)), [["codemode"], ["codemode"]]);
  const bytes = Buffer.byteLength(JSON.stringify(h.declarations[0]));
  assert.ok(bytes <= 3584, `The stable tool definition is ${bytes} bytes; budget is 3584.`);
  const nested = h.events.filter(event => event.type === "tool_execution_end" && event.parentToolCallId);
  assert.deepEqual(nested.map(event => event.toolName), ["write", "write", "read", "read", "edit", "read", "bash"]);
  assert.equal(nested[2].isError, true);
  assert.equal(nested.find(call => call.toolName === "edit").result.details.diff.includes("changed"), true);
  assert.equal(result.nestedCalls.calls.find(call => call.name === "edit").status, "ok");
});

test("native command guard blocks nested side effects without losing other results", async t => {
  const h = await harness(t);
  const result = await h.run(`return await Promise.all([
    tools.bash({command: "git reset --hard"}),
    tools.write({path: "kept", content: "safe"}),
    tools.not_registered({})
  ]);`);
  const values = data(result);
  assert.match(values[0].error, /Command protection \[git-discard\]/);
  assert.equal(values[1], "Successfully wrote to kept");
  assert.equal(typeof values[2].error, "string");
  assert.equal(await readFile(join(h.root, "kept"), "utf8"), "safe");
});

test("discovery loads deferred operations without changing the definition", async t => {
  const h = await harness(t, pi => {
    pi.registerTool({ name: "deferred_lookup", label: "Lookup", exposure: "deferred",
      description: "Look up a deferred frobnicator", parameters: Type.Object({ key: Type.String() }),
      outputSchema: Type.Object({ found: Type.String(), unused: Type.String() }),
      async execute(_id, { key }) { return { content: [{ type: "text", text: "found" }], details: {}, structuredContent: { found: key, unused: "omit" } }; } });
  });
  const first = await h.run(`const discovery = await tools.tool_search({query: "frobnicator"}); if (discovery.error) return discovery;
    const signature = await describeTool("deferred_lookup");
    const value = await tools.deferred_lookup({key: "selected"});
    return {found: value.found, described: signature.includes("key")};`);
  assert.deepEqual(data(first), { found: "selected", described: true });
  await h.run(`return await tools.deferred_lookup({key: "again"});`);
  assert.ok(h.session.getActiveToolNames().includes("deferred_lookup"));
  assert.deepEqual(h.declarations.map(tools => tools.map(tool => tool.name)), Array(4).fill(["codemode"]));
  assert.ok(h.declarations.every(tools => tools[0].description === h.declarations[0][0].description));
});

test("MCP and Chrome keep native data and rejection semantics", async t => {
  const h = await harness(t, pi => {
    for (const name of ["mcp__test__action", "chrome_devtools_evaluate"]) pi.registerTool({ name, label: name,
      exposure: "codemode", description: "External fixture", parameters: Type.Object({ fail: Type.Boolean() }),
      async execute(_id, { fail }) { if (fail) throw Error("external error"); return { content: [{ type: "text", text: "external value" }], details: {} }; } });
  });
  const result = await h.run(`return await Promise.allSettled([
    tools.mcp__test__action({fail: false}), tools.chrome_devtools_evaluate({fail: true})
  ]).then(xs => xs.map(x => x.status === "fulfilled" ? x.value : {error: x.reason.message}));`);
  assert.deepEqual(data(result), ["external value", { error: "external error" }]);
});

test("large returned data keeps the output excerpt and full artifact", async t => {
  const h = await harness(t);
  const result = await h.run(`return Array.from({length: 4000}, (_, i) => ({line: i, text: "x".repeat(30)}));`);
  const text = result.content.map(part => part.text ?? "").join("\n");
  assert.match(text, /The whole output:/);
  assert.ok(text.length < 4000);
  assert.equal(typeof result.details.full_output_artifact, "string");
  const path = text.match(/The whole output: (.*?) \(read/)[1];
  const full = JSON.parse(await readFile(path, "utf8"));
  assert.equal(full.length, 4000);
  assert.deepEqual(full[3999], { line: 3999, text: "x".repeat(30) });
});

test("primary agent requests await the approval service and preserve denial as data", async t => {
  let sessionId, approvals = 0;
  const h = await harness(t, pi => {
    pi.on("session_start", (_event, ctx) => {
      sessionId = ctx.sessionManager.getSessionId();
      providePrimaryAgents(sessionId, { async start(request, id, signal, context) {
        assert.equal(request.name, "Review");
        assert.match(id, /^call-\d+\/\d+$/);
        assert.equal(signal.aborted, false);
        if (!await context.ui.confirm("Start agent", request.task)) return {approved:false};
        throw Error("A denied request must not start an agent");
      } });
    });
    pi.on("session_shutdown", () => providePrimaryAgents(sessionId, undefined));
    for (const tool of createSubagentToolDefinitions({}, {getAuthority: () => ({sessionId})}, "root")) pi.registerTool(tool);
  });
  h.session.extensionRunner.setUIContext({ async confirm(title, task) {
    approvals++; assert.equal(title, "Start agent"); assert.equal(task, "Review changes"); return false;
  } }, "rpc");
  const result = await h.run(`const started = await tools.agent_start({name:"Review",task:"Review changes",primary:true});
    if (started.approved !== false) await tools.write({path:"must-not-exist",content:"started"}); return started;`);
  assert.deepEqual(data(result), {approved:false});
  assert.equal(approvals, 1);
  await assert.rejects(readFile(join(h.root, "must-not-exist")), {code:"ENOENT"});
});

test("a conversation handoff ends the request and agent turn before later side effects", async t => {
  const h = await harness(t, pi => pi.registerTool({name:"handoff",label:"Handoff",description:"Transfer the conversation",
    parameters:Type.Object({}), async execute() { return {content:[{type:"text",text:"Moved"}],details:{},terminate:true}; } }));
  const result = await h.run(`await tools.handoff({}); await tools.write({path:"after-handoff",content:"wrong"}); return "continued";`);
  assert.equal(result.content[0].text, "Moved");
  assert.equal(h.declarations.length, 1, "the model must not run again on the old host");
  await assert.rejects(readFile(join(h.root,"after-handoff")), {code:"ENOENT"});
});

test("nested questions use the native RPC UI and return the selected response", async t => {
  const h = await harness(t, askUser);
  const questions = [];
  h.session.extensionRunner.setUIContext({ async input(question) { questions.push(question); return "yes"; } }, "rpc");
  const result = await h.run(`const answer = await tools.ask_user({question: "Proceed?"}); return {response: answer.response, cancelled: answer.cancelled};`);
  assert.deepEqual(questions, ["Proceed?"]);
  assert.deepEqual(data(result), { response: { kind: "freeform", text: "yes" }, cancelled: false });
});

test("plan, shown-file and watch operations retain their data and separate cards", async t => {
  // Programs get the plan's and the watch's text, as the model does; the records stay in the results' details.
  const h = await harness(t, pi => { plan(pi); show(pi); watch(pi); });
  const result = await h.run(`
    const created = await tools.create_plan({objective: "Prepare note", steps:[{content:"Write note",status:"pending"}]});
    await tools.write({path:"note.md",content:"Ready"});
    const shown = await tools.show({title:"Note",items:[{file:"note.md"}]});
    const complete = await tools.update_plan({action:"complete",steps:[{content:"Write note",status:"completed"}]});
    const started = await tools.watch({until:"2099-01-01T09:00:00Z"});
    const stopped = await tools.watch({stop:/^Watching as (w\\d+)/.exec(started)[1]});
    return {created,complete,title:shown.title,stopped};`);
  assert.deepEqual(data(result), { created:"Plan (active): Prepare note\n[ ] Write note", complete:"Plan (complete): Prepare note\n[x] Write note",
    title:"Note", stopped:"Stopped w1. No active watches." });
  assert.equal(activeWatches(h.session.sessionManager.getSessionId()), 0);
  const nested = h.events.filter(e => e.type === "tool_execution_end" && e.parentToolCallId);
  assert.deepEqual(nested.map(e => e.toolName), ["create_plan","write","show","update_plan","watch","watch"]);
  assert.equal(nested[0].result.details.plan.objective, "Prepare note");
  assert.equal(nested[2].result.details.show.items[0].path, join(h.root, "note.md"));
  assert.equal(nested[3].result.details.plan.phase, "complete");
});

test("long literal content is written exactly and a later script sees branch state", async t => {
  const h = await harness(t);
  const contents = 'const r = /\\w+\\n/;\nconst template = `literal ${value}`;\n' + "line\n".repeat(200);
  const first = await h.run(`// @options: {"max_output_tokens": 2000}
    const result = await tools.write({path: "source.js", content: ${JSON.stringify(contents)}});
    store("saved", "source.js"); return result;`);
  assert.equal(first.isError, false, JSON.stringify(first.content));
  assert.equal(await readFile(join(h.root, "source.js"), "utf8"), contents);
  const second = await h.run(`return {saved: load("saved"), length: (await tools.read({path: load("saved")})).length};`);
  assert.deepEqual(data(second), { saved: "source.js", length: contents.length });
});

test("only edit, write and bash advertise presentation visibility and strip it before execution", async () => {
  for (const name of ["edit", "write", "bash", "read", "show", "agent_start", "create_plan", "watch", "ask_user", "tool_search"]) {
    let input;
    const tool = describedTool({ name, parameters: Type.Object({}), execute: async (_id, args) => { input = args; } });
    const eligible = ["edit", "write", "bash"].includes(name);
    assert.equal("show" in tool.parameters.properties, eligible, name);
    await tool.execute("call", { description: "Inspect output", ...(eligible ? { show: true } : {}) });
    assert.deepEqual(input, {}, name);
  }
});

test("a fresh single-tool conversation shows only selected edits and persists nested surfaces", async t => {
  const h = await harness(t, show);
  data(await h.run(`
    await tools.write({path:'quiet.txt',content:'quiet',show:false,description:'Keep this internal'});
    await tools.write({path:'review.txt',content:'before',show:false,description:'Prepare fixture'});
    await tools.edit({path:'review.txt',edits:[{oldText:'before',newText:'after'}],show:true,description:'Explain the useful edit'});
    return await tools.show({id:'result',title:'Result',spec:{root:'m',elements:{m:{type:'Metric',props:{label:'Result',value:'before'}}}}});`));
  data(await h.run(`return await tools.show({id:'result',pinned:true,patch:[{op:'replace',path:'/elements/m/props/value',value:'after'}]});`));
  const history = new Transcript().history(h.session.sessionManager.getBranch(), {}, undefined, undefined, h.root);
  const items = visibleWorkItems(history.messages);
  assert.equal(items.length, 2);
  assert.equal(items[0].title, "Explain the useful edit");
  assert.equal(items[0].block.path, join(h.root, "review.txt"));
  assert.equal(items[1].id, "part:result");
  assert.equal(items[1].block.shown.spec.elements.m.props.value, "after");
  assert.equal(items[1].block.shown.pinned, true);
  assert.equal(h.session.messages.some(message => message.role === 'toolResult'), true);
});

test("progress reaches Desk while a fresh conversation is blocked and finishes without another turn", { timeout: 15000 }, async t => {
  const h = await harness(t, show), received = [];
  let release;
  const progressed = new Promise(resolve => { release = resolve; });
  let finish;
  const completed = new Promise(resolve => { finish = resolve; });
  const feed = new TranscriptFeed(new Transcript(), () => h.session.sessionManager.getBranch(), () => "test", event => {
    received.push(event);
    const shown = event.message?.blocks.find(block => block.type === 'shown')?.shown;
    if (shown?.spec?.state?.done === 12) release();
    if (shown?.sourceStatus?.state === 'complete') { finish(); void writeFile(join(h.root, 'release'), 'done'); }
  }, () => h.root);
  const unsubscribe = h.session.subscribe(event => feed.event(event));
  t.after(() => { unsubscribe(); feed.close(); });
  const program = "const fs=require('node:fs');const watcher=fs.watch('.',(_,name)=>{if(name==='release'){watcher.close();process.exit(0)}});fs.writeFileSync('progress.txt','12/340 report.pdf\\n');";
  const command = `node -e ${JSON.stringify(program)}`;
  const running = h.run(`
    await tools.show({id:'files',title:'Files',source:{file:'progress.txt',pattern:'{done}/{total} {item}'},spec:{root:'p',elements:{p:{type:'Progress',props:{done:{$state:'/done'},total:{$state:'/total'},item:{$state:'/item'}}}}}});
    return await tools.bash({command:${JSON.stringify(command)},show:false,description:'Process files'});`);
  await progressed;
  assert.equal(h.events.some(event => event.type === 'tool_execution_end' && event.toolName === 'bash'), false, 'the process is still blocked when progress arrives');
  assert.equal(feed.history().messages.some(message => message.blocks.some(block => block.type === 'shown' && block.shown.spec?.state?.done === 12)), true);
  const modelRequests = h.declarations.length;
  await writeFile(join(h.root, 'progress.txt'), '340/340 finished\n', { flag: 'a' });
  await completed;
  assert.equal(h.declarations.length, modelRequests);
  await running;
  const finished = feed.history().messages.flatMap(message => message.blocks).find(block => block.type === 'shown' && block.shown.id === 'files');
  assert.equal(finished.shown.spec.state.done, 340);
  assert.equal(finished.shown.sourceStatus.state, 'complete');
  assert.equal(h.declarations.length, 2);
});

test("a watch starts after pruning released another branch's watch entries", async t => {
  const h = await harness(t, watch);
  // pi-session-memory empties the data of other branches' entries in a compacted session; their logs stay in the folder.
  h.session.sessionManager.appendCustomEntry("pi-watch/v1");
  const folder = join(h.root, "watch", h.session.sessionManager.getSessionId());
  await mkdir(folder, { recursive: true }); await writeFile(join(folder, "w7.log"), "");
  const result = await h.run(`
    const id = /^Watching as (w\\d+)/.exec(await tools.watch({until:"2099-01-01T09:00:00Z"}))[1];
    await tools.watch({stop:id});
    return {id};`);
  assert.deepEqual(data(result), { id: "w8" });
});


test("a program reads a long file whole, or exactly the lines it asks for", async t => {
  // An agent read a 1,347-line file, got Pi's first 50 KB page with its "Use offset=941 to continue" note, and wrote that
  // back over the file.
  const h = await harness(t);
  const original = Array.from({ length: 3000 }, (_, index) => `line ${index + 1} ${"x".repeat(40)}`).join("\n") + "\n";
  await writeFile(join(h.root, "long.txt"), original);
  const result = await h.run(`
    const whole = await tools.read({path:"long.txt"});
    await tools.write({path:"copy.txt",content:whole});
    const middle = await tools.read({path:"long.txt",offset:1500,limit:1300});
    const tail = await tools.read({path:"long.txt",offset:2999,limit:5});
    const rows = middle.split("\\n");
    return {count: rows.length, first: rows[0], last: rows.at(-1), tail};`);
  assert.equal(await readFile(join(h.root, "copy.txt"), "utf8"), original);
  const lines = original.split("\n");
  assert.deepEqual(data(result), { count: 1300, first: lines[1499], last: lines[2798], tail: lines.slice(2998).join("\n") });
});



test("a conversation keeps more than eight time watches", async t => {
  // Home schedules one watch per daily job, and a ninth job was refused: "At most 8 watches can run at once".
  const h = await harness(t, watch);
  const result = await h.run(`
    const ids = [];
    for (let day = 1; day <= 10; day++) ids.push(/^Watching as (w\\d+)/.exec(await tools.watch({until: "2099-01-" + String(day).padStart(2, "0") + "T09:00:00Z"}))[1]);
    for (const id of ids) await tools.watch({stop: id});
    return {ids};`);
  assert.deepEqual(data(result), { ids: ["w1", "w2", "w3", "w4", "w5", "w6", "w7", "w8", "w9", "w10"] });
});


test("a program is told which of its bash calls are still running in the background", async t => {
  // A program returned r.output, empty while the command ran on, and on a slow computer agents took that for a bash
  // call that returned nothing.
  const h = await harness(t, pi => pi.registerTool({ name: "bash", label: "bash", description: "Runs a command.",
    parameters: Type.Object({ command: Type.String(), wait: Type.Optional(Type.Number()) }),
    async execute(_id, params) {
      const running = params.command.startsWith("slow");
      return { content: [{ type: "text", text: running ? "Still running" : "ok" }], details: {},
        structuredContent: { output: running ? "" : "ok", exit_code: running ? null : 0, ...(running ? { running: "w7" } : {}) } };
    } }));
  const result = await h.run(`
    const fast = await tools.bash({command: "echo ok"});
    const slow = await tools.bash({command: "slow-search --everything\\nsecond line", wait: 20});
    return fast.output + slow.output;`);
  assert.deepEqual(result.content.map(part => part.text), ["ok",
    "Still running in the background after its wait, so the program had only its output so far: w7 (`slow-search --everything`). Each wakes you with its result when it ends."]);
});

test("a program that ends normally lists the operations that failed", async t => {
  // A program ignored an {error} result and the agent saw only "Script completed".
  const h = await harness(t);
  const result = await h.run(`
    await tools.edit({path: "missing.txt", edits: [{oldText: "a", newText: "b"}]});
    return "done";`);
  assert.deepEqual(result.content.map(part => part.text), ["done", "1 operation failed: edit: Could not edit file: missing.txt. Error code: ENOENT."]);
});
