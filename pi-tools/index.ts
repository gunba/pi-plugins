import {
  createCodemodeExtension, createToolSearchExtension,
  type ExtensionAPI, type ExtensionFactory, type ExtensionToolContext, type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";

const ERROR = Type.Object({ error: Type.String() });
const OBJECT = Type.Record(Type.String(), Type.Unknown());
const OUTPUTS: Record<string, TSchema> = {
  agent_start: OBJECT, agent_send: OBJECT, agent_list: OBJECT, agent_stop: OBJECT, agent_move: OBJECT,
  create_plan: Type.Object({ plan: Type.Union([OBJECT, Type.Null()]) }),
  update_plan: Type.Object({ plan: Type.Union([OBJECT, Type.Null()]) }),
  quest_add: OBJECT, quest_list: OBJECT, quest_update: OBJECT,
  ask_user: Type.Object({ response: Type.Unknown(), cancelled: Type.Boolean() }),
  show: OBJECT, watch: Type.Object({ text: Type.String(), watches: Type.Array(OBJECT) }),
  web_search: Type.Object({ pages: Type.Array(OBJECT), failures: Type.Array(OBJECT) }),
  web_fetch: Type.Object({ pages: Type.Array(OBJECT), failures: Type.Array(OBJECT) }),
  conversation_search: OBJECT, conversation_read: OBJECT,
  tool_search: Type.Object({ loaded: Type.Array(Type.String()) }),
};

function scriptTool<T extends { name: string; outputSchema?: TSchema }>(tool: T) {
  return external(tool.name) ? tool : {
    ...tool, outputSchema: Type.Union([tool.outputSchema ?? OUTPUTS[tool.name] ?? Type.String(), ERROR]),
  };
}
export const REQUEST_DESCRIPTION = `Execute a JavaScript request in QuickJS: top-level await, return, loops and conditions; no Node, filesystem, network or timers except through operations. Send raw source when supported, otherwise {code: "..."}.
Shared conventions:
- await tools.NAME(args) returns data or {error:string}; check errors before dependent effects. Await effects in order; Promise.all is for independent work. Pending calls are cancelled at return; completed effects are not rolled back.
- Return only needed fields: const r=await tools.bash({command:"git status --short",description:"Inspect changes"}); return r.error?r:{output:r.output};
- Every operation accepts description?:string: one short sentence for the user about what and why. It is omitted from the signatures below.
- Paths are relative to the working directory. Use read for contents, bash for file operations, edit for targeted replacements, write for new files or complete rewrites. Multiline template literals work; escape literal backticks and \${, or use quoted strings.
Core signatures (all return {error:string} on failure):
read({path:string,offset?:number,limit?:number}) -> string | image block. Lines are 1-based; continue with offset for long files.
bash({command:string,timeout?:number}) -> {output,exit_code,truncated,full_output_path?,wall_time_seconds}. Timeout is in seconds.
edit({path:string,edits:{oldText:string,newText:string}[]}) -> string. Each oldText must match once in the ORIGINAL file; replacements must not overlap.
write({path:string,content:string}) -> string. Creates parent directories; overwrites the file.
Discovery: await searchTools(query,{limit?,namespace?}) returns declarations. await describeTool(name) or describeNamespace(name) gives full contracts; ALL_TOOLS lists them. tools.tool_search({query,limit?}) activates matches and returns {loaded:string[]}. Use discovery for other operations before calling them; it leaves this definition unchanged.
Other operations: create_plan, update_plan; agent_start, agent_send, agent_list, agent_stop, agent_move; quest_add, quest_list, quest_update; watch; ask_user; show; web_search, web_fetch; conversation_search, conversation_read; list_mcp_resources, list_mcp_resource_templates, read_mcp_resource.
Globals: text(value), image(block), console.log and return emit output; exit() ends the request. store(key,value)/load(key) persist small JSON values on this branch. models.classify and models.generateImages work as in codemode; read Pi's docs/codemode.md first.
Optional first line: // @options: {"max_output_tokens":10000,"timeout_ms":60000}
Chrome and MCP operations retain their native result/error contracts. Images must be shown with image(), not serialized as text.`;

/** Chrome and MCP retain their own interfaces, including rejected calls. */
const external = (name: string) => name.startsWith("chrome_devtools_") || name.startsWith("mcp__");

/** Capture a built-in's definition without duplicating its implementation or reaching into private modules. */
function intercept(pi: ExtensionAPI, factory: ExtensionFactory, transform: (definition: ToolDefinition) => ToolDefinition): void {
  factory(new Proxy(pi, {
    get(target, property, receiver) {
      if (property === "registerTool") return (definition: ToolDefinition) => target.registerTool(transform(definition));
      return Reflect.get(target, property, receiver);
    },
  }));
}

function script(code: string): string {
  const options = code.match(/^\s*\/\/ @options:[^\r\n]*(?:\r?\n|$)/)?.[0] ?? "";
  return `${options}\nreturn await (async (tools) => {\n${code.slice(options.length)}\n})(new Proxy({...tools}, {get(target, name) {
    if (String(name).startsWith("chrome_devtools_") || String(name).startsWith("mcp__")) return target[name];
    return async args => {
      let outcome;
      try { outcome = await target[name](args); } catch (e) { return {error: String(e.message ?? e)}; }
      if (outcome[1]) { text(outcome[0]); exit(); }
      return outcome[0];
    };
  }}));`;
}

/** All nested operations still pass through Pi's validation, guards, approvals and Desk events. */
function context(ctx: ExtensionToolContext, terminate: () => void): ExtensionToolContext {
  return Object.create(ctx, {
    tools: { value: ctx.tools.map(scriptTool) },
    executeTool: { value: async (...args: Parameters<ExtensionToolContext["executeTool"]>) => {
      const outcome = await ctx.executeTool(...args);
      if (outcome.result.terminate) terminate();
      if (external(args[0])) return outcome;
      const result = outcome.result;
      const text = result.content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n");
      const value = outcome.isError ? { error: text || `Operation ${args[0]} failed` }
        : result.structuredContent ?? (["ask_user", "tool_search"].includes(args[0]) ? result.details : text);
      // The script unwraps this private envelope; a handoff must end it before another side effect.
      return { ...outcome, result: { ...result, structuredContent: [value, result.terminate === true] } };
    } },
  });
}

/** Single model-facing tool; active underlying operations stay active for permissions and transcript replay. */
export function createStructuredToolExtension(): ExtensionFactory {
  return pi => intercept(pi, createCodemodeExtension({ mode: "only" }), definition => {
    return {
      ...definition,
      defaultActive: true,
      description: REQUEST_DESCRIPTION,
      promptGuidelines: ["Use codemode for all operations. Return only needed fields; check operation.error before dependent effects."],
      outputSchema: Type.Unknown(),
      reachesTools: input => /\btool_search\b/.test(String(input.code)) ? "all" : definition.reachesTools?.(input) ?? "all",
      prepareLoadout(loadout) {
        return {
          descriptions: { codemode: REQUEST_DESCRIPTION },
          hiddenDeclarations: loadout.declared.filter(tool => tool.name !== "codemode" && !external(tool.name)).map(tool => tool.name),
        };
      },
      async execute(id, params, signal, update, ctx) {
        const input = params as { code: string };
        let terminate = false;
        const result = await definition.execute(id, { code: script(input.code) }, signal, update, context(ctx, () => { terminate = true; }));
        // Keep native failure diagnostics, image attachments, spill paths and nested-call metadata.
        const content = result.content.slice(1);
        const value = content.length === 1 && content[0]?.type === "text" ? content[0].text : undefined;
        let data: typeof result.structuredContent = value ?? JSON.parse(JSON.stringify(content));
        if (value !== undefined) { try { data = JSON.parse(value); } catch { /* Plain text is also a data value. */ } }
        return { ...result, content, structuredContent: data, ...(terminate ? { terminate: true } : {}) };
      },
    };
  });
}

/** Keep native search and activation, but allow a request to search and use the matches in the same script. */
export function createStructuredSearchExtension(): ExtensionFactory {
  return pi => intercept(pi, createToolSearchExtension(), definition => ({ ...definition, exposure: "direct", defaultActive: true }));
}

/** Explicit entry point for headless comparisons against the ordinary built-ins. */
export default function structuredTools(pi: ExtensionAPI): void {
  createStructuredToolExtension()(pi);
  createStructuredSearchExtension()(pi);
}
