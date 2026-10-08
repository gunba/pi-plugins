import type { SessionSnapshot } from "../shared/protocol.ts";
export function toolAvailability(tool: SessionSnapshot["tools"][number]): string {
	if (tool.declared) return "Shown to model";
	if (tool.callable) return "Callable from tools";
	return tool.active ? "Selected" : "Not selected";
}
