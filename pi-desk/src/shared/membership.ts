import { MEMBERSHIP_LEASE, type MembershipLease } from "./account.ts";
import { validId } from "./secure-channel.ts";

export class MembershipDenied extends Error {
	constructor() { super("Device access has been revoked."); }
}

/** Bound access from request start using a monotonic clock, even if wall time changes. */
export function membershipDeadline(lease: MembershipLease, requestedAt: number, peer?: string): number {
	if (!lease || !Array.isArray(lease.allowed) || lease.allowed.length > 32 || !lease.allowed.every(validId)
		|| !Number.isSafeInteger(lease.expires)) throw new Error("Invalid account authorization.");
	if (peer && !lease.allowed.includes(peer)) throw new MembershipDenied();
	const remaining = (lease.expires - Date.now() / 1000) * 1000;
	const deadline = Math.min(requestedAt + MEMBERSHIP_LEASE * 1000, performance.now() + remaining);
	if (deadline <= performance.now()) throw new Error("Account authorization expired.");
	return deadline;
}
