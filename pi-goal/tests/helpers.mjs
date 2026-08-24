import assert from "node:assert/strict";

import goalExtension from "../extensions/goal.ts";

export function makeTheme() {
	return {
		fg(_color, text) { return text; },
		bg(_color, text) { return text; },
		bold(text) { return text; },
		italic(text) { return text; },
		strikethrough(text) { return text; },
	};
}

export function createExtensionHarness(options = {}) {
	const branch = structuredClone(options.branch ?? []);
	const commands = new Map();
	const tools = new Map();
	const handlers = new Map();
	const entryRenderers = new Map();
	const messageRenderers = new Map();
	const sentMessages = [];
	const persistedSentMessages = new Set();
	const contextMessages = [];
	const statuses = new Map();
	const widgets = new Map();
	const theme = makeTheme();
	let idle = options.idle ?? true;
	let pending = options.pending ?? false;
	let nextEntry = branch.length + 1;

	function append(entry) {
		branch.push({
			id: `entry-${nextEntry++}`,
			parentId: branch.at(-1)?.id ?? null,
			timestamp: new Date(nextEntry * 1000).toISOString(),
			...entry,
		});
	}

	const pi = {
		registerCommand(name, value) { commands.set(name, value); },
		registerTool(value) { tools.set(value.name, value); },
		registerEntryRenderer(type, renderer) { entryRenderers.set(type, renderer); },
		registerMessageRenderer(type, renderer) { messageRenderers.set(type, renderer); },
		on(type, handler) {
			const list = handlers.get(type) ?? [];
			list.push(handler);
			handlers.set(type, list);
		},
		appendEntry(customType, data) {
			append({ type: "custom", customType, data: structuredClone(data) });
		},
		sendMessage(message, sendOptions) {
			sentMessages.push({ message: structuredClone(message), options: structuredClone(sendOptions) });
			if (options.persistSentMessages !== false) {
				append({
					type: "custom_message",
					customType: message.customType,
					content: structuredClone(message.content),
					display: message.display,
					details: structuredClone(message.details),
				});
			}
		},
	};

	const ctx = {
		mode: "tui",
		hasUI: true,
		cwd: "C:/workspace",
		sessionManager: { getBranch: () => branch },
		ui: {
			theme,
			setStatus(key, value) { statuses.set(key, value); },
			setWidget(key, value) { widgets.set(key, value); },
		},
		isIdle: () => idle,
		hasPendingMessages: () => pending,
	};

	const savedTaskPath = process.env.PI_SUBAGENT_TASK_PATH;
	if (options.topLevel === false) process.env.PI_SUBAGENT_TASK_PATH = "/root/test-child";
	else delete process.env.PI_SUBAGENT_TASK_PATH;
	try {
		goalExtension(pi);
	} finally {
		if (savedTaskPath === undefined) delete process.env.PI_SUBAGENT_TASK_PATH;
		else process.env.PI_SUBAGENT_TASK_PATH = savedTaskPath;
	}

	async function emit(type, event = {}) {
		const results = [];
		for (const handler of handlers.get(type) ?? []) {
			results.push(await handler({ type, ...event }, ctx));
		}
		return results;
	}

	async function emitContained(type, event = {}) {
		const results = [];
		const errors = [];
		for (const handler of handlers.get(type) ?? []) {
			try {
				results.push(await handler({ type, ...event }, ctx));
			} catch (error) {
				errors.push(error);
			}
		}
		return { results, errors };
	}

	return {
		branch,
		commands,
		tools,
		entryRenderers,
		messageRenderers,
		sentMessages,
		statuses,
		widgets,
		theme,
		ctx,
		emit,
		emitContained,
		append,
		setIdle(value) { idle = value; },
		setPending(value) { pending = value; },
		async start(reason = "startup") { await emit("session_start", { reason }); },
		async directInput(text = "work on this") {
			await emit("input", { text, source: "interactive" });
			await emit("before_agent_start", { prompt: text, systemPrompt: "", systemPromptOptions: {} });
			contextMessages.push({
				role: "user",
				content: [{ type: "text", text }],
				timestamp: Date.now(),
			});
			await emit("context", { messages: structuredClone(contextMessages) });
		},
		async admitLastRound() {
			const sentIndex = sentMessages.length - 1;
			const sent = sentMessages[sentIndex];
			assert.ok(sent, "expected one sent round");
			await emit("message_end", {
				message: {
					role: "custom",
					customType: sent.message.customType,
					content: sent.message.content,
					display: sent.message.display,
					details: sent.message.details,
					timestamp: Date.now(),
				},
			});
			if (options.persistSentMessages === false && !persistedSentMessages.has(sentIndex)) {
				persistedSentMessages.add(sentIndex);
				append({
					type: "custom_message",
					customType: sent.message.customType,
					content: structuredClone(sent.message.content),
					display: sent.message.display,
					details: structuredClone(sent.message.details),
				});
			}
			return sent;
		},
	};
}

export async function executeTool(harness, name, params = {}) {
	const tool = harness.tools.get(name);
	assert.ok(tool, `missing tool ${name}`);
	return tool.execute(`call-${name}`, params, undefined, undefined, harness.ctx);
}

export function textOf(component, width = 120) {
	return component?.render(width).join("\n") ?? "";
}
