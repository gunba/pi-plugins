import { calculateJwkThumbprint, importJWK, type JWK } from "jose";

export const DEVICE_AUDIENCE = "pi-desk.device";
export const DEVICE_TOKEN_TYPE = "pi-desk-device+jwt";
export const DEVICE_LIFETIME = 10 * 60;
export const MEMBERSHIP_LEASE = 60;
export type DeviceKind = "host" | "browser";
export interface DeviceKey extends JWK { kty: "EC"; crv: "P-256"; x: string; y: string }
export interface WorkspaceDevice {
	id: string;
	kind: DeviceKind;
	name: string;
	key: DeviceKey;
	thumbprint: string;
	created: number;
	seen: number;
	connected: boolean;
	revoked?: number;
}
export interface AccountConfiguration {
	origin: string;
	relayOrigin: string;
	appOrigins: string[];
	/**
	 * The workspace's permanent identity. Device identities, the device directory and party networking belong to it,
	 * so it stays the same when the account service, website or sign-in provider changes. Workspaces created with
	 * Microsoft sign-in keep their original "<tenant>:<owner>" value.
	 */
	workspace: string;
}
export interface MembershipPeer { id: string; thumbprint: string }
export interface MembershipLease { allowed: string[]; expires: number }
export function accountConfiguration(value: unknown): AccountConfiguration {
	if (!value || typeof value !== "object") throw new Error("Invalid account configuration.");
	const input = value as AccountConfiguration & { tenantId?: unknown; ownerObjectId?: unknown };
	if (!Array.isArray(input.appOrigins) || !input.appOrigins.length || input.appOrigins.length > 8
		|| !input.appOrigins.every(origin => typeof origin === "string")) throw new Error("Invalid app origins.");
	// Configurations saved before 0.5.115 named the workspace by its Microsoft tenant and owner.
	const workspace = input.workspace ?? (input.tenantId !== undefined && input.ownerObjectId !== undefined
		? `${identifier(input.tenantId)}:${identifier(input.ownerObjectId)}` : undefined);
	if (typeof workspace !== "string" || !/^[A-Za-z0-9:._-]{1,200}$/.test(workspace)) throw new Error("Invalid workspace.");
	return {
		origin: accountOrigin(input.origin), relayOrigin: accountOrigin(input.relayOrigin),
		appOrigins: [...new Set(input.appOrigins.map(accountOrigin))], workspace,
	};
}
export const workspaceIdentity = (config: AccountConfiguration) => config.workspace;

export function identifier(value: unknown): string {
	if (typeof value !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)) {
		throw new Error("Invalid identifier.");
	}
	return value.toLowerCase();
}
export function accountOrigin(value: string): string {
	const url = new URL(value);
	if (url.username || url.password || url.search || url.hash || url.pathname !== "/"
		|| !(url.protocol === "https:" || url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) {
		throw new Error("Account origins require HTTPS or a loopback development address.");
	}
	return url.origin;
}
export async function deviceKey(value: unknown): Promise<{ key: DeviceKey; thumbprint: string }> {
	if (!value || typeof value !== "object") throw new Error("Invalid device public key.");
	const input = value as JWK;
	if (input.kty !== "EC" || input.crv !== "P-256" || input.d !== undefined
		|| typeof input.x !== "string" || !/^[\w-]{43}$/.test(input.x)
		|| typeof input.y !== "string" || !/^[\w-]{43}$/.test(input.y)) {
		throw new Error("Expected a public P-256 device key.");
	}
	const key: DeviceKey = { kty: "EC", crv: "P-256", x: input.x, y: input.y };
	await importJWK(key, "ES256");
	return { key, thumbprint: await calculateJwkThumbprint(key) };
}
