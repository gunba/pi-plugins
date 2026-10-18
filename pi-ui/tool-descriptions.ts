/**
 * Every tool call carries a one-line description for the user of what it does and why, written by the model as it
 * calls the tool (as Claude Code's shell tool does). The field is added to each tool's declared parameters, so the
 * model's own calls keep it in the conversation; it is removed before the tool runs, so no tool ever sees it.
 */
export const CALL_DESCRIPTION = "description";
// Plain JSON Schema: Pi's validator accepts it inside TypeBox and JSON Schema parameters alike.
const FIELD = { type: "string", description: "One short sentence for the user: what this call does and why. Always include it." };
const WRAPPED = Symbol.for("pi.tool-description");

type Tool = { name: string; parameters: unknown; execute: (id: string, params: never, ...rest: never[]) => unknown };
export function describedTool<T extends Tool>(tool: T): T {
	if ((tool as Record<symbol, unknown>)[WRAPPED]) return tool;
	const schema = tool.parameters as { type?: unknown; properties?: Record<string, unknown> } | undefined;
	// Only object parameters can take another field, and a tool's own "description" parameter is left alone.
	if (!schema || schema.type !== "object" || !schema.properties || typeof schema.properties !== "object" || CALL_DESCRIPTION in schema.properties) return tool;
	return { ...tool, [WRAPPED]: true, parameters: { ...schema, properties: { ...schema.properties, [CALL_DESCRIPTION]: FIELD } },
		execute: (id: string, params: never, ...rest: never[]) => {
			const { [CALL_DESCRIPTION]: _description, ...input } = (params ?? {}) as Record<string, unknown>;
			return tool.execute(id, input as never, ...rest);
		} };
}
/** Applies the description field to an agent's tools now and whenever its tool set changes. */
export function describeAgentTools(state: { tools: Tool[] }): void {
	const property = Object.getOwnPropertyDescriptor(state, "tools");
	if (!property?.get || !property.set || (property.set as unknown as Record<symbol, unknown>)[WRAPPED]) return;
	const original = property.set;
	const set = Object.assign(function (this: unknown, tools: Tool[]) { original.call(state, tools.map(describedTool)); }, { [WRAPPED]: true });
	Object.defineProperty(state, "tools", { get: property.get, set, configurable: true, enumerable: property.enumerable });
	state.tools = state.tools;
}
/** The description a call carries, if any. */
export function callDescription(args: unknown): string | undefined {
	const value = args && typeof args === "object" ? (args as Record<string, unknown>)[CALL_DESCRIPTION] : undefined;
	return typeof value === "string" && value.trim() ? value.trim().slice(0, 300) : undefined;
}
