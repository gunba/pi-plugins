import { appendFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getCurrentTools } from "@earendil-works/pi-ai";
import {
  createAgentSession, createCodemodeExtension, createToolSearchExtension, DefaultResourceLoader,
  getAgentDir, ModelRuntime, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { describeAgentTools, describeSessionTools } from "../../../pi-ui/tool-descriptions.ts";
import { createStructuredToolExtension, createStructuredSearchExtension } from "../../../pi-tools/index.ts";
import fixture from "./fixture.mjs";
import { cases } from "./cases.mjs";

const [arm, modelRef, caseId, directory] = process.argv.slice(2);
const root = fileURLToPath(new URL("../../../", import.meta.url));
const [provider, modelId] = modelRef.split("/");
const trial = cases.find(item => item.id === caseId);
const log = value => appendFileSync(join(directory, "trace.jsonl"), JSON.stringify(value) + "\n");
const started = performance.now();
const totals = { input:0, cached:0, cacheWrite:0, output:0, cost:0, modelCalls:0, calls:0, operations:0, toolErrors:0 };
let session, failure;
try {
  const settings = SettingsManager.inMemory({ packages:[], extensions:[], defaultTools:["read","bash","edit","write","codemode","tool_search"],
    compaction:{enabled:false}, retry:{enabled:false}, codemode:{mode:"on"} });
  const runtime = await ModelRuntime.create();
  const model = runtime.getModel(provider, modelId);
  if (!model) throw Error(`Model unavailable: ${modelRef}`);
  const paths = [
    "node_modules/@gotgenes/pi-anthropic-auth/src/index.ts", "pi-codex-wire/extensions/index.ts",
    "pi-output-budget/extensions/index.ts", "pi-command-guard/index.ts", "pi-plan/extensions/plan.ts",
    "pi-watch/index.ts", "pi-show/extensions/show.ts", "pi-ask-user/index.ts",
    "pi-web-search/extensions/web-search.ts", "pi-conversation-search/index.ts",
  ];
  const loader = new DefaultResourceLoader({ cwd:directory, agentDir:getAgentDir(), settingsManager:settings,
    noExtensions:true, noSkills:true, noThemes:true, noPromptTemplates:true, noContextFiles:true,
    additionalExtensionPaths:["builtin:codemode", "builtin:tool-search", ...paths.map(path => resolve(root,path))],
    extensionFactories:[
      {name:"codemode",builtin:true,replaceable:true,factory:arm === "single" ? createStructuredToolExtension() : createCodemodeExtension()},
      {name:"tool-search",builtin:true,replaceable:true,factory:arm === "single" ? createStructuredSearchExtension() : createToolSearchExtension()},
      fixture,
    ] });
  await loader.reload();
  const errors = loader.getExtensions().errors;
  if (errors.length) throw Error(JSON.stringify(errors));
  ({session} = await createAgentSession({ cwd:directory, agentDir:getAgentDir(), settingsManager:settings,
    modelRuntime:runtime, model, thinkingLevel:"high", resourceLoader:loader,
    sessionManager:SessionManager.create(directory,join(directory,"session")) }));
  describeSessionTools(session); describeAgentTools(session.agent.state);
  await session.bindExtensions({mode:"rpc"});
  const transform = session.agent.transformContext;
  session.agent.transformContext = async (...args) => {
    const messages = await transform(...args);
    const tools = getCurrentTools(messages), names = tools.map(tool => tool.name);
    if (arm === "single" && (names.length !== 1 || names[0] !== "codemode")) throw Error(`Single-tool loadout is wrong: ${names}`);
    if (arm === "current" && (!names.includes("read") || !names.includes("codemode"))) throw Error(`Baseline loadout is wrong: ${names}`);
    log({event:"definition", names, bytes:Buffer.byteLength(JSON.stringify(tools))});
    return messages;
  };
  session.subscribe(event => {
    if (event.type === "tool_execution_start") {
      if (event.parentToolCallId) totals.operations++; else totals.calls++;
      log({event:"call",at:performance.now()-started,id:event.toolCallId,parent:event.parentToolCallId,tool:event.toolName,args:event.args});
    }
    if (event.type === "tool_execution_end") {
      if (event.isError) totals.toolErrors++;
      log({event:"result",id:event.toolCallId,parent:event.parentToolCallId,tool:event.toolName,error:event.isError,content:event.result.content});
    }
    if (event.type === "message_end" && event.message.role === "assistant") {
      const usage = event.message.usage;
      totals.modelCalls++;
      for (const [key,source] of [["input","input"],["cached","cacheRead"],["cacheWrite","cacheWrite"],["output","output"]]) totals[key]+=usage?.[source]??0;
      totals.cost+=usage?.cost?.total??0;
      log({event:"assistant",usage,stop:event.message.stopReason,error:event.message.errorMessage,content:event.message.content});
      if (event.message.errorMessage) failure = event.message.errorMessage;
      if (totals.modelCalls >= 30) { failure = "Model call limit (30)"; void session.abort(); }
    }
  });
  await session.prompt(trial.prompt);
} catch (error) { failure = error.stack ?? String(error); }
finally {
  await session?.extensionRunner.emit({type:"session_shutdown",reason:"quit"});
  session?.dispose();
  writeFileSync(join(directory,"done.json"),JSON.stringify({arm,model:modelRef,case:caseId,seconds:(performance.now()-started)/1000,...totals,...(failure?{failure}:{})},null,2));
}
