import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { stageHomeJobs } from "../src/host/home-jobs.ts";

const source = process.argv[2];
if (!source) throw Error("Usage: node pi-desk/manage/home-jobs.ts <handover.md> [jobs-directory]. This stages files only; it never schedules or sends.");
const directory = process.argv[3] ? resolve(process.argv[3]) : join(getAgentDir(), "home", "jobs");
stageHomeJobs(directory, readFileSync(resolve(source), "utf8"));
console.log(`Staged seven jobs in ${directory}. No watches were armed and no deliveries were sent. After merge, ask the real Home conversation to read this folder and arm its watches.`);
