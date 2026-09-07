import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
	LAUNCH_ENTRY,
	SubagentRuntime,
} from "../extensions/subagent-runtime.ts";
import { createSubagentToolDefinitions } from "../extensions/subagent-tools.ts";

export function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

export async function waitUntil(predicate, message = "condition", timeoutMs = 3000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`Timed out waiting for ${message}`);
}

export class FakeDriver {
	constructor(factory, input) {
		this.factory = factory;
		this.input = input;
		this.prompts = [];
		this.isRunning = false;
		this.interruptions = 0;
		this.pending = undefined;
	}

	async prompt(message) {
		this.prompts.push(message);
		this.factory.promptLog.push({ id: this.input.descriptor.childSessionId, message });
		this.isRunning = true;
		try {
			return await this.factory.onPrompt(this, message);
		} finally {
			this.isRunning = false;
			this.pending = undefined;
		}
	}

	receiveNotice(notice) {
		(this.notices ??= []).push(notice);
	}

	interrupt() {
		this.interruptions++;
		this.pending?.resolve({ output: "partial", stopReason: "aborted" });
	}

	dispose() {
		this.disposed = true;
	}
}

export class FakeDriverFactory {
	constructor(onPrompt = async (_driver, message) => ({ output: `done: ${message}`, stopReason: "completed" })) {
		this.onPrompt = onPrompt;
		this.opens = [];
		this.promptLog = [];
	}

	async open(input) {
		const driver = new FakeDriver(this, input);
		this.opens.push(driver);
		return driver;
	}
}

export function blockingPrompt(driver) {
	const pending = deferred();
	driver.pending = pending;
	return pending.promise;
}

export function createHarness(options = {}) {
	const root = options.root ?? mkdtempSync(join(tmpdir(), "pi-subagents-dsh-"));
	const ownsRoot = !options.root;
	const cwd = join(root, "workspace");
	const rootSessions = join(root, "root-sessions");
	const childSessions = join(root, "child-sessions");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(rootSessions, { recursive: true });
	mkdirSync(childSessions, { recursive: true });
	const rootManager =
		options.rootManager ??
		SessionManager.create(cwd, rootSessions, { id: randomUUID() });
	const launches = new Set();
	for (const entry of rootManager.getBranch()) {
		if (
			entry.type === "custom" &&
			entry.customType === LAUNCH_ENTRY &&
			entry.data?.parentSessionId === rootManager.getSessionId() &&
			typeof entry.data.childId === "string"
		)
			launches.add(entry.data.childId);
	}
	const notices = [];
	const host = {
		rootSessionId: rootManager.getSessionId(),
		rootSessionFile: rootManager.getSessionFile(),
		cwd,
		agentDir: root,
		activeRootLaunchIds: launches,
		isProjectTrusted: () => options.projectTrusted ?? true,
		recordRootLaunch(childId) {
			launches.add(childId);
			rootManager.appendCustomEntry(LAUNCH_ENTRY, {
				parentSessionId: rootManager.getSessionId(),
				childId,
				createdAt: Date.now(),
			});
		},
		deliverRootNotice(notice) {
			notices.push(notice);
			return true;
		},
		resolveModel(ref) {
			return { provider: ref.provider, id: ref.id };
		},
	};
	const factory = options.factory ?? new FakeDriverFactory();
	let runtime;
	runtime = new SubagentRuntime(
		host,
		factory,
		(childRuntime, authority, mode) =>
			createSubagentToolDefinitions(
				childRuntime,
				{
					getAuthority: () => authority,
					getToolNames: () => childRuntime.toolNamesFor(authority),
				},
				mode,
			),
		{ sessionDir: childSessions, maxDepth: options.maxDepth, maxActive: options.maxActive, openTimeoutMs: options.openTimeoutMs },
	);
	runtime.initialize();
	const parent = (overrides = {}) => ({
		authority: runtime.rootAuthority,
		sessionManager: rootManager,
		model: { provider: "test", id: "model" },
		thinkingLevel: "high",
		toolNames: ["read", "bash", "ask_user", "spawn_agent"],
		toolCallId: "current-call",
		projectTrusted: options.projectTrusted ?? true,
		cwd,
		...overrides,
	});
	return {
		root,
		cwd,
		rootManager,
		childSessions,
		launches,
		notices,
		host,
		factory,
		runtime,
		parent,
		cleanup: async () => {
			await runtime.shutdown();
			if (ownsRoot) rmSync(root, { recursive: true, force: true });
		},
	};
}

export function childParent(harness, childId, authority, overrides = {}) {
	return {
		authority,
		sessionManager: SessionManager.open(
			harness.runtime.getSessionFile(childId),
			harness.childSessions,
		),
		model: { provider: "test", id: "model" },
		thinkingLevel: "high",
		toolNames: ["read", "bash", "ask_user"],
		toolCallId: `call-${childId}`,
		cwd: harness.cwd,
		projectTrusted: harness.host.isProjectTrusted(),
		...overrides,
	};
}

export function completedOutcome(output = "done") {
	return { output, stopReason: "completed" };
}

export function usageFor(input, output, contextTokens, total) {
	return { input, output, contextTokens, cacheRead: 0, cacheWrite: 0, totalTokens: input + output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total } };
}
