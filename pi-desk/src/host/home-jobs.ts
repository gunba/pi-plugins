import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface HomeJob { id: string; name: string; times: string[]; dayOfMonth?: number; delivery: "home" | "email" }
export const homeJobs: HomeJob[] = [
	{ id: "tv", name: "TV show alerts", times: ["09:00"], delivery: "home" },
	{ id: "ai-jobs", name: "AI job shortlist", times: ["09:00"], delivery: "home" },
	{ id: "youtube", name: "Daily YouTube watch guide", times: ["09:08"], delivery: "email" },
	{ id: "promotions", name: "Monthly promotional email review", times: ["09:08"], dayOfMonth: 1, delivery: "home" },
	{ id: "forever", name: "WoW Forever news", times: ["09:00", "18:00"], delivery: "home" },
	{ id: "roundup", name: "Hacker News and alphaXiv", times: ["09:00"], delivery: "home" },
	{ id: "email-triage", name: "Proactive email triage", times: ["07:00", "09:00", "11:00", "13:00", "15:00", "17:00", "19:00", "21:00"], delivery: "home" },
];

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

/** Preserve a complete handover as inert files. Never overwrite dedup state, arm watches or deliver anything. */
export function stageHomeJobs(directory: string, inventory: string): void {
	const sections = inventory.split(/\n---\n/), supplements = sections.filter(section => section.includes("HANDOVER SUPPLEMENT"));
	const continuity = sections.filter(section => /HANDOVER SUPPLEMENT|FULL TV TITLE BASELINE|HISTORICAL WRITTEN DEDUP|HISTORICAL DEDUP GAP CLOSED/.test(section));
	if (supplements.length !== 3) throw Error("The handover needs all three continuity supplements.");
	const parsed = homeJobs.map(job => {
		if (job.id === "email-triage") {
			const functional = /General proactive email triage[\s\S]*?(?=\n\nYouTube latest sent example:)/.exec(supplements[0]!)?.[0];
			if (!functional) throw Error("Missing proactive email triage requirements.");
			return { job, instructions: functional + "\n\nCadence approved by Jordan: every two hours, 07:00 through 21:00 Australia/Perth. This replaces the handover's pending-cadence note.",
				schedule: "BEGIN:VEVENT\nDTSTART;TZID=Australia/Perth:20261101T070000\nRRULE:FREQ=DAILY;BYHOUR=7,9,11,13,15,17,19,21;BYMINUTE=0;BYSECOND=0\nEND:VEVENT" };
		}
		const section = sections.find(section => section.includes(`ACTIVE JOB: ${job.name}\n`));
		const instructions = section && /Task instructions \(verbatim\):\n([\s\S]*?)\nImplementation requirements:/.exec(section)?.[1];
		const schedule = section && /Schedule \(verbatim\):\n([\s\S]*?)\n\nTask instructions/.exec(section)?.[1];
		if (!instructions || !schedule || !section?.includes("Time zone: Australia/Perth")) throw Error(`Missing complete instructions or schedule: ${job.name}`);
		return { job, instructions, schedule };
	});
	const archived = join(directory, "handover.md");
	if (existsSync(archived) && readFileSync(archived, "utf8") !== inventory) throw Error("A different handover is already staged. Merge its additions without replacing existing job state.");
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const save = (path: string, text: string) => { if (!existsSync(path)) writeFileSync(path, text, { mode: 0o600, flag: "wx" }); };
	save(join(directory, "handover.md"), inventory);
	save(join(directory, "operating-requirements.md"), continuity.join("\n---\n"));
	for (const { job, instructions, schedule } of parsed) {
		const folder = join(directory, job.id); mkdirSync(folder, { recursive: true, mode: 0o700 });
		save(join(folder, "instructions.md"), instructions + "\n");
		save(join(folder, "schedule.ics"), schedule + "\n");
		const seed = supplements[job.id === "youtube" || job.id === "promotions" || job.id === "email-triage" ? 0 : job.id === "roundup" ? 2 : 1]!;
		const extra = continuity.filter(section => job.id === "tv" ? /FULL TV TITLE BASELINE|HISTORICAL DEDUP GAP CLOSED/.test(section)
			: job.id === "roundup" ? /HISTORICAL WRITTEN DEDUP|HISTORICAL DEDUP GAP CLOSED/.test(section) : false);
		const baseline = [seed, ...extra, ...(job.id === "youtube" ? ["Before any send, check for a same-day SENT guide as well as video-ID deduplication. During the approved overlap, distinguish Home: subjects from Dot's unprefixed delivery; never send a second Home guide that day."] : [])].join("\n---\n");
		save(join(folder, "baseline.md"), baseline.trim() + "\n");
		save(join(folder, "state.json"), JSON.stringify({ version: 1, baseline: "baseline.md", lastChecked: null, watch: null, checks: [], delivered: [], verifiedDeliveries: [] }, null, 2) + "\n");
	}
	save(join(directory, "index.json"), JSON.stringify({ version: 1, timeZone: "Australia/Perth", state: "staged", jobs: homeJobs }, null, 2) + "\n");
	save(join(directory, "README.md"), `# Home scheduled jobs\n\nThese files are staged, not active. After merge, ask the real Home conversation on the workspace server to read this folder and arm the seven jobs. Do not run deliveries during setup.\n\nThe schedule uses Jordan's Australia/Perth timezone, independent of the workspace server's location or system timezone. Pass each job's next deadline from home_jobs as an absolute ISO watch.until value, not a server-local HH:MM.\n\nFor each wake: read instructions.md, baseline.md and state.json; re-arm the next absolute watch before research, recording its ID/deadline in state.json. Deduplicate against both the seed baseline and later delivered records. Record source failures as failures, not no-change. Update checked state even when silent; record delivery only after a confirmed receipt. Read the full continuity archive in operating-requirements.md for account limits and known coverage gaps.\n\nChat deliveries use home_notify (Home plus phone notification). The YouTube guide uses Gmail create_draft and send_draft, with the specified From/To and no chat success notice. Preserve all read-only/approval limits. During overlap, prefix subjects/notification titles with Home:. General email triage runs every two hours from 07:00 through 21:00 Australia/Perth, as approved by Jordan. Do not recreate quest reminders or cancelled work.\n`);
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
