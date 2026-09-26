import type { ExtensionAPI, ToolInfo } from "@earendil-works/pi-coding-agent";

export const CHILD_POLICIES_EVENT = "pi-subagents:child-policies:v1";

export type ChildPolicySource = Pick<ToolInfo["sourceInfo"], "path" | "scope">;

/** Hook-only extensions publish their source synchronously on the session bus. */
export function childPolicySources(pi: ExtensionAPI): ChildPolicySource[] {
	const request = { policies: [] as ChildPolicySource[] };
	pi.events.emit(CHILD_POLICIES_EVENT, request);
	return request.policies;
}
