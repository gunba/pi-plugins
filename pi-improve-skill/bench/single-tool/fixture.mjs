import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createSubagentToolDefinitions } from "../../../pi-agents/subagents/subagent-tools.ts";
import { providePrimaryAgents } from "../../../pi-agents/primary.ts";
import { activeWatches } from "../../../pi-watch/index.ts";

// Only the remote agent transport is replaced. Tool validation, routing and formatting are real.
export default function fixture(pi) {
  let sessionId;
  const agents = [
    ["api-a", "API contracts", "running", "/workspace/api"],
    ["api-b", "API handlers", "running", "/workspace/api"],
    ["api-idle", "API spare", "idle", "/workspace/api"],
    ["api-old", "Legacy API", "running", "/workspace/api-old"],
    ["web-a", "Website", "running", "/workspace/web"],
    ["api-closed", "Old review", "offline", "/workspace/api"],
  ].map(([id,label,state,cwd]) => ({id,label,state,cwd,computer:"local",kind:"primary"}));
  pi.on("session_start", (_event, ctx) => {
    sessionId = ctx.sessionManager.getSessionId();
    providePrimaryAgents(sessionId, {
      list() { return {agents, nextOffset:null, computers:[{id:"local",name:"Benchmark",state:"online"}]}; },
      async send({to,message}) {
        appendFileSync(join(ctx.cwd,"sent.jsonl"), JSON.stringify({to,message})+"\n");
        return {queued:[{to,wakeRequested:true}]};
      },
      async start() { throw Error("Starting agents is outside this fixture"); },
      async close() { throw Error("Stopping agents is outside this fixture"); },
    });
  });
  const runtime = { listNamedAgents() { return []; }, resolveTarget() { throw Error("Not a secondary agent"); } };
  for (const tool of createSubagentToolDefinitions(runtime, {getAuthority: () => ({sessionId})}, "root")) pi.registerTool(tool);
  pi.on("agent_end", (_event, ctx) => {
    const probe = {};
    pi.events.emit("pi-plan/read-v1", probe);
    writeFileSync(join(ctx.cwd,"control-state.json"), JSON.stringify({phase:probe.plan?.phase, watches:activeWatches(sessionId)}));
  });
  pi.on("session_shutdown", () => providePrimaryAgents(sessionId, undefined));
}
