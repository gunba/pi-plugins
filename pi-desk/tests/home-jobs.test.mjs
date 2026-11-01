import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { homeJobs, nextHomeJob, readHomeJobs, stageHomeJobs } from "../src/host/home-jobs.ts";

const inventory = homeJobs.filter(job => job.id !== "email-triage").map(job => `ACTIVE JOB: ${job.name}\nTime zone: Australia/Perth\nSchedule (verbatim):\nBEGIN:VEVENT\nRRULE:FREQ=DAILY\nEND:VEVENT\n\nTask instructions (verbatim):\nRead-only synthetic instructions for ${job.name}. Stay silent when unchanged.\nImplementation requirements: Preserve deduplication.`).join("\n---\n")
	+ "\n---\nHANDOVER SUPPLEMENT 1: continuity\nGeneral proactive email triage reads relevant mail; do not act without approval.\n\nYouTube latest sent example: old-video-id\n---\nHANDOVER SUPPLEMENT 2: TV, jobs, Forever\nPreviously alerted episode.\n---\nHANDOVER SUPPLEMENT 3: roundup\nhttps://example.org/old-paper\n---\nFULL TV TITLE BASELINE\nA title without a verified IMDb ID.\n---\nHISTORICAL WRITTEN DEDUP A\nhttps://example.org/history-a\n---\nHISTORICAL WRITTEN DEDUP B\nhttps://example.org/history-b\n---\nHISTORICAL DEDUP GAP CLOSED\nhttps://example.org/recovered\nEarlier TV episode.";

test("Perth deadlines preserve the seven approved schedules at day and month boundaries", () => {
	assert.deepEqual(homeJobs.map(job => [job.id, job.times, job.dayOfMonth ?? null]), [
		["tv", ["09:00"], null], ["ai-jobs", ["09:00"], null], ["youtube", ["09:08"], null], ["promotions", ["09:08"], 1],
		["forever", ["09:00", "18:00"], null], ["roundup", ["09:00"], null], ["email-triage", ["07:00", "09:00", "11:00", "13:00", "15:00", "17:00", "19:00", "21:00"], null],
	]);
	assert.equal(nextHomeJob(homeJobs[0], Date.parse("2026-11-01T08:59:00+08:00")), "2026-11-01T01:00:00.000Z");
	assert.equal(nextHomeJob(homeJobs[4], Date.parse("2026-11-01T09:00:00+08:00")), "2026-11-01T10:00:00.000Z");
	assert.equal(nextHomeJob(homeJobs[3], Date.parse("2026-10-31T23:59:00+08:00")), "2026-11-01T01:08:00.000Z");
	assert.equal(nextHomeJob(homeJobs[3], Date.parse("2026-12-01T09:08:00+08:00")), "2027-01-01T01:08:00.000Z");
	assert.equal(nextHomeJob(homeJobs[6], Date.parse("2026-11-01T21:00:00+08:00")), "2026-11-01T23:00:00.000Z");
});

test("staging preserves verbatim instructions and every historical seed without scheduling or replacing state", t => {
	const directory = mkdtempSync(join(tmpdir(), "home-jobs-")); t.after(() => rmSync(directory, { recursive: true, force: true }));
	stageHomeJobs(directory, inventory);
	assert.equal(readFileSync(join(directory, "handover.md"), "utf8"), inventory);
	assert.equal(readFileSync(join(directory, "tv", "instructions.md"), "utf8"), "Read-only synthetic instructions for TV show alerts. Stay silent when unchanged.\n");
	assert.match(readFileSync(join(directory, "tv", "baseline.md"), "utf8"), /A title without a verified IMDb ID/);
	const roundup = readFileSync(join(directory, "roundup", "baseline.md"), "utf8");
	assert.match(roundup, /old-paper/); assert.match(roundup, /history-a/); assert.match(roundup, /history-b/); assert.match(roundup, /recovered/);
	assert.match(readFileSync(join(directory, "youtube", "baseline.md"), "utf8"), /same-day SENT guide/);
	assert.match(readFileSync(join(directory, "email-triage", "instructions.md"), "utf8"), /Cadence approved by Jordan: every two hours, 07:00 through 21:00 Australia\/Perth/);
	const state = join(directory, "tv", "state.json");
	assert.equal(JSON.parse(readFileSync(state)).watch, null);
	writeFileSync(state, '{"delivered":["keep-this"]}');
	stageHomeJobs(directory, inventory);
	assert.deepEqual(JSON.parse(readFileSync(state)), { delivered: ["keep-this"] });
	assert.equal(readHomeJobs(directory, Date.parse("2026-11-01T08:00:00+08:00")).jobs.length, 7);
	assert.throws(() => stageHomeJobs(directory, inventory + "\nA new supplement"), /different handover/);
});

test("incomplete handovers fail before creating job files", t => {
	const directory = mkdtempSync(join(tmpdir(), "home-jobs-missing-")), target = join(directory, "jobs");
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	assert.throws(() => stageHomeJobs(target, inventory.replace("ACTIVE JOB: TV show alerts", "MISSING JOB")), /Missing complete instructions/);
	assert.equal(existsSync(target), false);
});
