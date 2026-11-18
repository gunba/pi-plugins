/**
 * The account service's clock, as this device has measured it against its own.
 *
 * The service dates what it issues by its own clock (credentials, leases, approval deadlines) and refuses a request
 * whose proof is dated more than 5 s ahead of it or has expired. A device whose clock is wrong by seconds or minutes,
 * which its owner may not be allowed to set, would be refused, would refuse valid credentials and would see a 60 s
 * lease as already over. So a device measures its clock against the Date header of the service's replies, and signs
 * and checks by the service's time. The account service and the relay never measure: their own clock is the time.
 */
let offset = 0;

/** A Date header names a whole second and the reply takes time to arrive: a smaller difference is not measurable. */
const MEASURABLE = 2000;

/** The time by the account service's clock, in milliseconds. */
export function accountNow(): number { return Date.now() + offset; }

/** How far this device's clock is ahead of the account service's, in milliseconds; 0 when no difference was measured. */
export function accountClockLead(): number { return -offset || 0; }

/**
 * Measures this device's clock against a reply from the account service, given the reply's Date header. True when
 * the measurement moved the clock, which makes a request the service refused worth signing again.
 */
export function measureAccountClock(date: string | null | undefined): boolean {
	const served = date ? Date.parse(date) : NaN;
	if (!Number.isFinite(served)) return false;
	// The header names the second the reply was written in, so the service's time then was half a second later on average.
	const measured = served + 500 - Date.now();
	const next = Math.abs(measured) < MEASURABLE ? 0 : measured;
	if (Math.abs(next - offset) < MEASURABLE) return false;
	offset = next;
	return true;
}
