import {
  createCodemodeExtension, createToolSearchExtension,
  type ExtensionAPI, type ExtensionFactory, type ExtensionToolContext, type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";

const ERROR = Type.Object({ error: Type.String() });
const OBJECT = Type.Record(Type.String(), Type.Unknown());
const OUTPUTS: Record<string, TSchema> = {
  agent_start: OBJECT, agent_send: OBJECT, agent_list: OBJECT, agent_stop: OBJECT, agent_resume: OBJECT, agent_move: OBJECT,
  create_plan: Type.Object({ plan: Type.Union([OBJECT, Type.Null()]) }),
  update_plan: Type.Object({ plan: Type.Union([OBJECT, Type.Null()]) }),
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
/** The description's first words, which identify the single-tool interface wherever its definition is seen. */
export const REQUEST_PREFIX = "Run a JavaScript program (QuickJS) that calls operations and returns data.";
const CORE = new Set(["codemode", "tool_search", "read", "bash", "edit", "write", "ask_user", "web_search", "web_fetch", "watch"]);
/**
 * The definition, naming the session's other always-available operations so a tool added in a new version is listed.
 * Tools loaded on demand are left out: loading one must not change the definition, and searchTools finds them.
 */
export const requestDescription = (others: readonly string[]) => `Run a JavaScript program (QuickJS) that calls operations and returns data. Top-level await, return, loops and conditions work. There is no Node: no process, require, Buffer, imports, files, network or timers except through operations. Send the source raw where raw input is accepted, otherwise as {code}.
- await tools.NAME(args) returns the operation's data, or {error:string} if it failed. Check for an error before a step that depends on it.
- Await side effects in order; use Promise.all only for independent steps. Calls still pending at return are cancelled; finished ones are not undone.
- Return only the fields you need: const r=await tools.bash({command:"git status --short",description:"Check changes"}); return r.error??r.output;
- Every operation takes description: one short sentence for the user on what the call does. The signatures below leave it out.
- Paths are relative to the working directory. Write valid JavaScript: every object field needs key:value. In template literals, escape \` and \${, or use quoted strings.
- Before repeating a change over many files, make it once and check it.
Core operations:
read({path,offset?,limit?,page?}) -> the whole text (PDF and Office too), the lines asked (from 1), or an image; page: a PDF/Office page image.
bash({command,wait?,warn?,progress?}) -> {output,exit_code,truncated,full_output_path?,wall_time_seconds,running?}. After wait s (60) it runs on, waking you when done; progress: a command printing how far it is; warn: s between wakes.
edit({path,edits:[{oldText,newText}]}) -> text. Each oldText must occur once in the original file; edits must not overlap.
write({path,content}) -> text. Creates folders and replaces the file: for new files and full rewrites.
Common operations (more: describeTool):
ask_user({question,options?,context?,done_when?}) -> {response,cancelled}: when only Jordan can decide, supply or approve something. done_when: a command that exits 0 once it's done.
web_search({goal,queries}): current facts; one search per question. web_fetch({urls,goal?,full?}) -> {pages,failures}: read pages and PDFs by URL. Cite sources as links.
watch({command?,every?,until?,wake_when?,stop?}): to wait for a command, a time or a change, end the program with a watch and be woken; never loop calls to pass time.
Other operations; await describeTool(name) gives one's full contract:
${others.join("\n")}
searchTools(query,{limit?,namespace?}) and describeNamespace(name) find others, ALL_TOOLS lists all; tools.tool_search({query,limit?}) loads matches ({loaded}). This definition stays the same.
Output: return, text(value), image(block) and console.log. exit() stops the program. store(key,value) and load(key) keep small JSON values on this branch. models.classify and models.generateImages work as in codemode; read Pi's docs/codemode.md first.
Optional first line: // @options: {"max_output_tokens":10000,"timeout_ms":60000}
Chrome and MCP operations keep their own results and errors. Show images with image(), never as text.`;

/** name({a,b?}) from a tool's parameter schema, leaving out the description every operation takes. */
const signature = (name: string, parameters: unknown) => {
  const schema = parameters as { properties?: Record<string, unknown>; required?: string[] };
  const required = new Set(schema.required ?? []);
  const keys = Object.keys(schema.properties ?? {}).filter(key => key !== "description");
  return `${name}({${keys.map(key => required.has(key) ? key : `${key}?`).join(",")}})`;
};
/** What each operation is for, in at most 100 characters, worded so agents reach for it at the right moment. */
const INTROS: Record<string, string> = {
  show: "Show Jordan a finished result, work to review or a file you changed for him; not routine steps.",
  create_plan: "Before multi-step work: state the objective and the steps. One plan per branch.",
  update_plan: "As you work: mark steps done or change them; pause, resume, complete or block the plan.",
  agent_start: "Only when Jordan asks: start a helper that reports back, or (primary) a new Desk conversation.",
  agent_send: "Message any agent on Jordan's computers, or reply to one; its replies come back to you.",
  agent_list: "Find agents and computers by name or folder, and check on your helpers.",
  agent_stop: "Interrupt a helper's turn (it keeps its work) or close a primary agent you started.",
  agent_resume: "Reopen a closed conversation without sending it anything, e.g. when Jordan asks to resume one.",
  agent_move: "Only when Jordan asks: move this conversation to another of his computers.",
  conversation_search: "Recall past conversations: an earlier decision, command, path or error.",
  conversation_read: "Read the passages around a conversation_search result.",
  home_jobs: "List the scheduled jobs, their files and next deadlines (Perth time). Arms nothing.",
  chrome_devtools_list_pages: "List the browser's open tabs and their ids.",
  chrome_devtools_select_page: "Choose the tab later browser calls act on.",
  chrome_devtools_navigate: "Open a URL in a tab, with Jordan's signed-in sessions; ask before using his own tab.",
  chrome_devtools_evaluate: "Run a JavaScript expression in the page to read or operate it; keep each call short.",
  chrome_devtools_screenshot: "Capture the page as a PNG; look at it with image().",
  home_notify: "Deliver a scheduled job's result to Home and Jordan's phone, only when worth telling.",
};
/** An operation's intro, or for one without, its first sentence cut to 100 characters at a word. */
const intro = (name: string, description: string) => {
  if (INTROS[name]) return INTROS[name];
  const first = description.replace(/\s+/g, " ").trim().split(/(?<=[.!?]) /)[0]!;
  return first.length <= 100 ? first : `${first.slice(0, 99).replace(/\s+\S*$/, "")}…`;
};

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
    if (typeof name === "string" && !(name in target)) return async () => ({error: \`No operation \${name}. Find one with searchTools(query).\`});
    return async args => {
      let outcome;
      try { outcome = await target[name](args); } catch (e) { return {error: String(e.message ?? e)}; }
      if (outcome[1]) { text(outcome[0]); exit(); }
      return outcome[0];
    };
  }}));`;
}

type Schema = { type?: string | string[]; properties?: Record<string, Schema>; required?: string[]; items?: Schema; enum?: unknown[];
  anyOf?: Schema[]; const?: unknown };
/** A schema as a short TypeScript-like type: enough to correct a call, without the descriptions. */
function shape(schema: Schema | undefined, depth = 0): string {
  if (!schema) return "unknown";
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  if (schema.enum) return schema.enum.map(value => JSON.stringify(value)).join("|");
  if (schema.anyOf) return schema.anyOf.map(option => shape(option, depth)).join("|");
  if (schema.type === "array") { const item = shape(schema.items, depth); return item.includes("|") ? `(${item})[]` : `${item}[]`; }
  if (schema.properties) {
    if (depth > 2) return "{…}";
    const required = new Set(schema.required ?? []);
    return `{${Object.entries(schema.properties).filter(([key]) => key !== "description" || depth > 0)
      .map(([key, value]) => `${key}${required.has(key) ? "" : "?"}:${shape(value, depth + 1)}`).join(",")}}`;
  }
  return Array.isArray(schema.type) ? schema.type.join("|") : schema.type ?? "unknown";
}
/**
 * Arguments that don't match an operation get its current parameters back, so a call written from a stale or skipped
 * contract is corrected in one step. Pi's echo of the arguments is dropped: the program already has them.
 */
function invalidCall(text: string, tool: { name: string; parameters?: unknown } | undefined): string | undefined {
  if (!tool || !text.startsWith(`Validation failed for tool "${tool.name}"`)) return;
  return `${text.split("\n\nReceived arguments:")[0]}\nCurrent parameters: ${tool.name}(${shape(tool.parameters as Schema)})`;
}

type Outcome = Awaited<ReturnType<ExtensionToolContext["executeTool"]>>;
const READ_LIMIT = 16 * 1024 * 1024;
/**
 * A program reads a text file whole, or exactly the lines it asked for. Pi's read shows a long file a page at a time and
 * ends the page with a note on how to go on; a program took such a page for the whole file and wrote it back, losing
 * the rest and keeping the note. Each further page goes through Pi's read like the first, under the same guards.
 */
async function readWhole(ctx: ExtensionToolContext, params: unknown, options: Parameters<ExtensionToolContext["executeTool"]>[2]): Promise<Outcome> {
  const request = (params && typeof params === "object" ? params : {}) as { offset?: number; limit?: number };
  const pages: string[] = [];
  let offset = request.offset ?? 1, wanted = request.limit, bytes = 0;
  for (let call = params; ;) {
    const outcome = await ctx.executeTool("read", call, options);
    if (outcome.isError || outcome.result.content.some(part => part.type === "image")) return outcome;
    const text = outcome.result.content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n");
    const truncation = (outcome.result.details as { truncation?: { content: string; truncated: boolean; outputLines: number; firstLineExceedsLimit?: boolean } } | undefined)?.truncation;
    if (truncation?.firstLineExceedsLimit) return { ...outcome, isError: true };
    const page = truncation?.truncated ? truncation.content : text.replace(/\n\n\[\d+ more lines in file\. Use offset=\d+ to continue\.\]$/, "");
    pages.push(page); bytes += page.length;
    if (bytes > READ_LIMIT) return { ...outcome, isError: true, result: { ...outcome.result, content: [{ type: "text", text: "The file is over 16 MB; read it in parts with offset and limit." }] } };
    if (wanted !== undefined) wanted -= truncation?.truncated ? truncation.outputLines : wanted;
    if (!truncation?.truncated || wanted !== undefined && wanted <= 0) {
      const whole = pages.join("\n");
      return { ...outcome, result: { ...outcome.result, content: [{ type: "text", text: whole }], structuredContent: whole, details: undefined } };
    }
    offset += truncation.outputLines;
    call = { ...request, offset, ...(wanted !== undefined ? { limit: wanted } : {}) };
  }
}

/** All nested operations still pass through Pi's validation, guards, approvals and Desk events. */
function context(ctx: ExtensionToolContext, terminate: () => void): ExtensionToolContext {
  return Object.create(ctx, {
    tools: { value: ctx.tools.map(scriptTool) },
    executeTool: { value: async (...args: Parameters<ExtensionToolContext["executeTool"]>) => {
      const outcome = args[0] === "read" ? await readWhole(ctx, args[1], args[2]) : await ctx.executeTool(...args);
      if (outcome.result.terminate) terminate();
      if (external(args[0])) return outcome;
      const result = outcome.result;
      const text = result.content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n");
      const value = outcome.isError ? { error: invalidCall(text, ctx.tools.find(tool => tool.name === args[0])) || text || `Operation ${args[0]} failed` }
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
      description: requestDescription([]),
      promptGuidelines: ["Do everything through codemode: one program can make many calls and return only what you need."],
      outputSchema: Type.Unknown(),
      reachesTools: input => /\btool_search\b/.test(String(input.code)) ? "all" : definition.reachesTools?.(input) ?? "all",
      prepareLoadout(loadout) {
        // Every operation a program can call, so agents know them all: the declared ones, those loaded on demand (callable
        // from programs without loading) and the browser's. MCP servers' tools are listed by server in the system prompt.
        const declared = new Set(loadout.declared.map(tool => tool.name));
        const others = loadout.registered.filter(tool => !CORE.has(tool.name) && !tool.name.startsWith("mcp__")
          && (declared.has(tool.name) || ["deferred", "codemode"].includes(loadout.getExposure(tool.name))));
        // Hidden tools' rules leave the system prompt with their declarations, so the program tool carries them; the
        // file operations' rules are already in their signatures above.
        const rules = [...new Set(loadout.declared.filter(tool => !["codemode", "read", "bash", "edit", "write"].includes(tool.name) && !external(tool.name))
          .flatMap(tool => loadout.getPromptGuidelines(tool.name).map(rule => rule.trim())).filter(Boolean))];
        return {
          descriptions: { codemode: requestDescription(others.map(tool => `${signature(tool.name, tool.parameters)}: ${intro(tool.name, tool.description)}`)) + (rules.length ? `\nRules:\n${rules.map(rule => `- ${rule}`).join("\n")}` : "") },
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
        // Operations return {error} instead of throwing, so a program that doesn't check one still ends normally; the
        // agent is told which failed. A program that fails already lists its calls.
        const failed = result.isError ? [] : ((result.details as { calls?: { name: string; status: string; error?: string }[] } | undefined)
          ?.calls ?? []).filter(call => call.status === "error");
        const note = failed.length ? [{ type: "text" as const, text: `${failed.length} operation${failed.length === 1 ? "" : "s"} failed: ${failed.slice(0, 5)
          .map(call => `${call.name}: ${(call.error ?? "").replace(/\s+/g, " ").slice(0, 160)}`).join("; ")}${failed.length > 5 ? "; …" : ""}` }] : [];
        return { ...result, content: [...content, ...note], structuredContent: data, ...(terminate ? { terminate: true } : {}) };
      },
    };
  });
}

/** Keep native search and activation, but allow a request to search and use the matches in the same script. */
export function createStructuredSearchExtension(): ExtensionFactory {
  return pi => intercept(pi, createToolSearchExtension(), definition => ({ ...definition, exposure: "direct", defaultActive: true }));
}

/** Install the request and discovery adapters together. */
export default function structuredTools(pi: ExtensionAPI): void {
  createStructuredToolExtension()(pi);
  createStructuredSearchExtension()(pi);
}
