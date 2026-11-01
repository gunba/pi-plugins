import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { nextHomeJob } from "../src/host/home-jobs.ts";

const homeJobs = [
	{ id: "tv", name: "TV show alerts", times: ["09:00"], delivery: "home" },
	{ id: "ai-jobs", name: "AI job shortlist", times: ["09:00"], delivery: "home" },
	{ id: "youtube", name: "Daily YouTube watch guide", times: ["09:08"], delivery: "email" },
	{ id: "promotions", name: "Monthly promotional email review", times: ["09:08"], dayOfMonth: 1, delivery: "home" },
	{ id: "forever", name: "WoW Forever news", times: ["09:00", "18:00"], delivery: "home" },
	{ id: "roundup", name: "Hacker News and alphaXiv", times: ["09:00"], delivery: "home" },
	{ id: "email-triage", name: "Proactive email triage", times: ["07:00", "09:00", "11:00", "13:00", "15:00", "17:00", "19:00", "21:00"], delivery: "home" },
];

test("Perth deadlines keep the seven approved schedules at day and month boundaries", () => {
	assert.equal(nextHomeJob(homeJobs[0], Date.parse("2026-11-01T08:59:00+08:00")), "2026-11-01T01:00:00.000Z");
	assert.equal(nextHomeJob(homeJobs[4], Date.parse("2026-11-01T09:00:00+08:00")), "2026-11-01T10:00:00.000Z");
	assert.equal(nextHomeJob(homeJobs[3], Date.parse("2026-10-31T23:59:00+08:00")), "2026-11-01T01:08:00.000Z");
	assert.equal(nextHomeJob(homeJobs[3], Date.parse("2026-12-01T09:08:00+08:00")), "2027-01-01T01:08:00.000Z");
	assert.equal(nextHomeJob(homeJobs[6], Date.parse("2026-11-01T21:00:00+08:00")), "2026-11-01T23:00:00.000Z");
});

test("a Sydney or UTC server keeps Jordan's Australia/Perth deadlines", () => {
	const module = new URL("../src/host/home-jobs.ts", import.meta.url).href;
	const script = `import { nextHomeJob } from ${JSON.stringify(module)}; console.log(JSON.stringify(${JSON.stringify(homeJobs)}.map(job => nextHomeJob(job, Date.parse("2026-11-01T00:30:00Z")))));`;
	const expected = ["2026-11-01T01:00:00.000Z", "2026-11-01T01:00:00.000Z", "2026-11-01T01:08:00.000Z", "2026-11-01T01:08:00.000Z", "2026-11-01T01:00:00.000Z", "2026-11-01T01:00:00.000Z", "2026-11-01T01:00:00.000Z"];
	for (const TZ of ["Australia/Sydney", "UTC"]) {
		const result = execFileSync(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, TZ }, encoding: "utf8" });
		assert.deepEqual(JSON.parse(result), expected, TZ);
	}
});
