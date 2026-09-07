/** Native model shaping, pinned to openai/codex rust-v0.147.0.
 * https://github.com/openai/codex/tree/be6e8eac029b183056b7e4402879f15d2c85f61b/codex-rs
 * Sources: core/src/client.rs:816-935; core/src/client_common.rs:52-108;
 * codex-api/src/common.rs:249-333 (serde omission matters);
 * tools/src/tool_spec.rs:95-141; protocol/src/openai_models.rs:769-781.
 * This module supports Pi's flat function/custom tools, including the native
 * `functions` namespace. Other namespaces/hosted tools need an executor mapping
 * and are rejected rather than silently dispatched to the wrong Pi tool.
 */
type ObjectValue = Record<string, unknown>;

function object(value: unknown, label: string): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as ObjectValue;
}
function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  return value;
}
function booleanField(value: unknown, fallback: boolean, label: string): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new TypeError(`${label} must be boolean`);
  return value;
}
function choice(value: unknown, values: string[], label: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !values.includes(value)) {
    throw new TypeError(`Unsupported ${label}: ${String(value)}`);
  }
  return value;
}
const efforts = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

function functionTool(value: unknown): ObjectValue {
  const tool = object(value, "tool");
  if (tool.type !== "function" && tool.type !== "custom") {
    throw new TypeError(`Unsupported Pi tool type: ${String(tool.type)}`);
  }
  if (typeof tool.name !== "string" || !tool.name) throw new TypeError("Tool needs a name");
  if (tool.type === "function") {
    object(tool.parameters, "function parameters");
    // Native ResponsesApiTool strict is a bool, not Pi's null.
    tool.strict = false;
  }
  return tool;
}

function toolCatalog(values: unknown[], lite: boolean): ObjectValue[] {
  const output: ObjectValue[] = [];
  const members: ObjectValue[] = [];
  let position: number | undefined;
  let description = "";
  const names = new Set<string>();
  for (const value of values) {
    const tool = object(value, "tool");
    let tools: ObjectValue[];
    if (tool.type === "namespace") {
      if (tool.name !== "functions") throw new TypeError("Only the functions namespace maps to Pi tools");
      tools = array(tool.tools, "namespace tools").map(functionTool);
      if (typeof tool.description === "string" && tool.description.trim()) description = tool.description;
    } else {
      tools = [functionTool(tool)];
    }
    for (const member of tools) {
      if (names.has(member.name as string)) throw new TypeError(`Duplicate tool name: ${member.name}`);
      names.add(member.name as string);
    }
    if (lite) {
      position ??= output.length;
      members.push(...tools);
    } else {
      output.push(tool);
    }
  }
  if (position !== undefined && members.length) {
    output.splice(position, 0, { type: "namespace", name: "functions", description, tools: members });
  }
  return output;
}

function stripImages(content: unknown): void {
  if (!Array.isArray(content)) return;
  for (const value of content) {
    const item = object(value, "content item");
    if (item.type === "input_image") delete item.detail;
  }
}
function liteInput(value: unknown): ObjectValue {
  const item = object(value, "input item");
  if (item.type === "message" || (item.type === undefined && typeof item.role === "string")) {
    stripImages(item.content);
  } else if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
    stripImages(item.output);
  } else if (item.type === "function_call" || item.type === "custom_tool_call") {
    if (item.namespace != null && item.namespace !== "functions") {
      throw new TypeError("Cannot map a non-functions call namespace to Pi");
    }
    // Pi's stored assistant messages lose namespace; restore the one used by
    // our catalog without changing name, call_id, arguments, or result pairing.
    item.namespace = "functions";
  } else if (item.type === "additional_tools") {
    item.tools = toolCatalog(array(item.tools, "additional tools"), true);
  }
  return item;
}

/** Shape a Pi-serialized body using one matching native /models entry.
 * Returns a deep clone. Caller must skip this function when no metadata exists.
 * Pi's existing explicit effort/verbosity wins; catalog defaults fill absence.
 */
export function shapeModelBody(body: ObjectValue, metadata: ObjectValue): ObjectValue {
  if (typeof metadata.slug !== "string" || metadata.slug !== body.model) {
    throw new TypeError("Native model metadata.slug must exactly match body.model");
  }
  const result = structuredClone(body);
  const lite = booleanField(metadata.use_responses_lite, false, "use_responses_lite");
  const sourceReasoning = result.reasoning == null ? {} : object(result.reasoning, "reasoning");
  const effort = choice(sourceReasoning.effort ?? metadata.default_reasoning_level, efforts, "reasoning effort");
  const summary = choice(sourceReasoning.summary ?? "auto", ["none", "auto", "concise", "detailed"], "reasoning summary");
  const reasoning: ObjectValue = {};
  if (effort !== undefined) reasoning.effort = effort === "ultra" ? "max" : effort;
  if (booleanField(metadata.supports_reasoning_summary_parameter, true, "supports_reasoning_summary_parameter") && summary !== "none") {
    reasoning.summary = summary;
  }
  if (lite) reasoning.context = "all_turns";
  result.reasoning = reasoning;
  result.include = ["reasoning.encrypted_content"];
  delete result.temperature; // No native ResponsesApiRequest temperature field.

  const text = result.text == null ? {} : object(result.text, "text");
  const verbosity = booleanField(metadata.support_verbosity, false, "support_verbosity")
    ? choice(text.verbosity ?? metadata.default_verbosity, ["low", "medium", "high"], "verbosity")
    : undefined;
  delete text.verbosity;
  if (verbosity !== undefined) text.verbosity = verbosity;
  if (Object.keys(text).length) result.text = text;
  else delete result.text;

  const tier = result.service_tier;
  const tiers = array(metadata.service_tiers ?? [], "service_tiers").map(value => {
    const entry = object(value, "service tier");
    if (typeof entry.id !== "string") throw new TypeError("Service tier needs id");
    return entry.id;
  });
  if (tier === undefined || tier === null || tier === "default" || !tiers.includes(tier as string)) {
    delete result.service_tier;
  }
  const tools = toolCatalog(array(result.tools ?? [], "tools"), lite);
  if (lite) {
    const input = array(result.input, "input").map(liteInput);
    const prefix: ObjectValue[] = [{ type: "additional_tools", role: "developer", tools }];
    if (result.instructions != null && typeof result.instructions !== "string") {
      throw new TypeError("instructions must be a string");
    }
    if (result.instructions) prefix.push({ role: "developer", type: "message", content: [{ type: "input_text", text: result.instructions }] });
    result.input = [...prefix, ...input];
    delete result.instructions; // Empty native string is skipped by serde.
    delete result.tools;
    result.parallel_tool_calls = false;
  } else {
    result.tools = tools;
    result.parallel_tool_calls = result.parallel_tool_calls === true &&
      booleanField(metadata.supports_parallel_tool_calls, true, "supports_parallel_tool_calls");
    if (result.instructions === "") delete result.instructions;
  }
  return result;
}

/** Normalize native lite events before Pi's shared parser; names and IDs remain
 * unchanged. Also normalize completion output arrays used by continuation code.
 * Unknown namespaces fail: silently dropping them could execute the wrong tool.
 */
export function normalizeLiteEvent(event: ObjectValue): ObjectValue {
  const result = structuredClone(event);
  function normalize(value: unknown): void {
    const item = object(value, "response item");
    if (item.type !== "function_call" && item.type !== "custom_tool_call") return;
    if (item.namespace != null && item.namespace !== "functions") {
      throw new TypeError("Cannot map a non-functions response namespace to Pi");
    }
    delete item.namespace;
  }
  if (result.item != null) normalize(result.item);
  if (result.response != null) {
    const response = object(result.response, "response");
    if (response.output != null) array(response.output, "response output").forEach(normalize);
  }
  return result;
}
