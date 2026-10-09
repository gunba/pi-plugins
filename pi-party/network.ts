import type { Member, PartyMessage } from "./store.ts";

export const NETWORK_LIMIT = 4096;
export const MAX_NETWORK_PACKET = 31 * 1024 * 1024;
export const uuid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
export const agentId = (computer: string, session: string) => `${session}@${computer}`;
export const nativeId = (id: string) => id.split("@")[0];
export type NetworkMember = Omit<Member, "owner" | "computer" | "heartbeat">;
export interface DeliveryReceipt { id: string; accepted: boolean; error?: string }
/** User-approved agent creation over the computer channel; not a general remote command. */
export interface PartyOperation {
	id: string; sender: string; sender_epoch: string; created: number; expires: number;
	kind: "create" | "fork"; cwd: string; task: string; label: string; call?: string;
}
export interface OperationResult { id: string; result?: { session: string; state: string; key?: string }; error?: string }
export type PartyPacket =
	| { type: "directory"; agents: NetworkMember[] }
	| { type: "presence" }
	| { type: "messages"; messages: PartyMessage[] }
	| { type: "receipts"; receipts: DeliveryReceipt[] }
	| { type: "operations"; operations: PartyOperation[] }
	| { type: "operation-results"; results: OperationResult[] };

export function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid party packet.");
	return value as Record<string, unknown>;
}
function text(value: unknown, maximum: number): string {
	if (typeof value !== "string" || value.length > maximum) throw Error("Invalid party text.");
	return value;
}
function integer(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
	if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) throw Error("Invalid party number.");
	return value as number;
}
function id(value: unknown): string {
	if (!uuid(value)) throw Error("Invalid party agent identity.");
	return value;
}
export function remoteMember(computer: string, value: unknown, now: number): Member {
	const input = record(value), state = text(input.state, 20), kind = text(input.kind, 20);
	if (!["idle", "working", "offline"].includes(state) || !["session", "child"].includes(kind)) throw Error("Invalid party agent state.");
	return { session: agentId(id(computer), id(input.session)), computer, owner: "",
		room: "", epoch: id(input.epoch), agent_epoch: id(input.agent_epoch),
		label: text(input.label, 120), cwd: text(input.cwd, 4096), description: text(input.description, 1600),
		state, kind, heartbeat: state === "offline" ? 0 : now, wakes: integer(input.wakes, 8),
		delivery: integer(input.delivery, 1), muted: integer(input.muted, 1) };
}
export function remoteMessage(value: unknown): PartyMessage {
	const input = record(value);
	if (input.kind !== "message" || input.room !== "") throw Error("Only direct agent messages are supported.");
	const message: PartyMessage = { id: id(input.id), sender: id(input.sender), recipient: id(input.recipient),
		sender_epoch: id(input.sender_epoch), recipient_epoch: id(input.recipient_epoch),
		sender_label: text(input.sender_label, 120), text: text(input.text, MAX_NETWORK_PACKET), room: "",
		created: integer(input.created), wake: integer(input.wake, 1), kind: "message", invite_room: "" };
	if (!message.text.trim()) throw Error("Invalid agent message.");
	return message;
}
export function partyOperation(value: unknown): PartyOperation {
	const input = record(value), kind = text(input.kind, 20);
	if (kind !== "create" && kind !== "fork") throw Error("Invalid agent operation.");
	const operation: PartyOperation = { id: id(input.id), sender: id(input.sender), sender_epoch: id(input.sender_epoch),
		kind, created: integer(input.created), expires: integer(input.expires),
		cwd: text(input.cwd, 4096), task: text(input.task, 32_000), label: text(input.label, 120) };
	if (operation.expires <= operation.created || operation.expires - operation.created > 300_000) throw Error("Invalid agent operation lifetime.");
	if (kind === "fork") {
		operation.call = text(input.call, 512);
		if (!operation.call) throw Error("Specify the executing fork call.");
	}
	if (!operation.cwd.trim() || !operation.task.trim() || !operation.label.trim()) throw Error("Specify a directory, task and name for the new agent.");
	return operation;
}
export function operationResult(value: unknown): OperationResult {
	const input = record(value), result: OperationResult = { id: id(input.id) };
	if (input.error !== undefined) result.error = text(input.error, 2000);
	else {
		const output = record(input.result);
		result.result = { session: id(output.session), state: text(output.state, 40),
			...(output.key !== undefined ? { key: id(output.key) } : {}) };
	}
	return result;
}
export function networkMembers(members: Member[], now: number, lease: number): NetworkMember[] {
	return members.map(({ owner: _owner, computer: _computer, heartbeat, ...member }) => ({ ...member,
		label: member.label.slice(0, 120), cwd: member.cwd.slice(0, 4096), description: member.description.slice(0, 1600),
		state: heartbeat > now - lease ? member.state : "offline" })).sort((a, b) => a.session.localeCompare(b.session));
}
