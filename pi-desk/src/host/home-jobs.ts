import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface HomeJob { id: string; name: string; times: string[]; dayOfMonth?: number; delivery: "home" | "email" }
/** Next absolute deadline in Australia/Perth (UTC+08:00, no daylight saving), strictly after `now`. */
export function nextHomeJob(job: HomeJob, now = Date.now()): string {
	const local = new Date(now + 8 * 3_600_000), year = local.getUTCFullYear(), month = local.getUTCMonth(), day = local.getUTCDate();
	for (let offset = 0; offset < 33; offset++) {
		const date = new Date(Date.UTC(year, month, day + offset));
		if (job.dayOfMonth && date.getUTCDate() !== job.dayOfMonth) continue;
		for (const time of [...job.times].sort()) {
			const [hour, minute] = time.split(":").map(Number);
			const deadline = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), hour! - 8, minute);
			if (deadline > now) return new Date(deadline).toISOString();
		}
	}
	throw Error("No next Home job deadline.");
}

/** Job paths and future wake deadlines; reading this manifest has no scheduling side effects. */
export function readHomeJobs(directory: string, now = Date.now()) {
	if (!existsSync(join(directory, "index.json"))) return { directory, state: "not-staged", jobs: [] };
	const index = JSON.parse(readFileSync(join(directory, "index.json"), "utf8")) as { version: number; jobs: HomeJob[] };
	if (index.version !== 1 || !Array.isArray(index.jobs) || index.jobs.length > 32) throw Error("Invalid Home job manifest.");
	return { directory, timeZone: "Australia/Perth", jobs: index.jobs.map(job => {
		if (!/^[a-z0-9-]+$/.test(job.id) || !Array.isArray(job.times) || !job.times.length || job.times.some(time => !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time))
			|| job.dayOfMonth !== undefined && job.dayOfMonth !== 1) throw Error("Invalid Home job schedule.");
		return { ...job, instructions: join(directory, job.id, "instructions.md"), baseline: join(directory, job.id, "baseline.md"), state: join(directory, job.id, "state.json"), next: nextHomeJob(job, now) };
	}), triage: "Approved cadence: 07:00, 09:00, 11:00, 13:00, 15:00, 17:00, 19:00 and 21:00 Australia/Perth." };
}
