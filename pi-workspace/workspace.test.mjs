import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify, stripVTControlCharacters } from "node:util";
import { createServer } from "node:http";
import { once } from "node:events";
import { installRuntimeResolver } from "./cli.mjs";
installRuntimeResolver();
const { WorkspaceApp, launchOptions } = await import("./app.ts");
const { Reader, WorkspaceLayout } = await import("./views.ts");
const { workspaceTheme } = await import("./theme.ts");
const { FileRepository, readDocument, fileLocation } = await import("./files.ts");
const { WorkspaceHttp } = await import("./http.ts");
const { getWorkspace } = await import("./api.ts");
const sdk = await import("@earendil-works/pi-coding-agent");
const ai = await import("@earendil-works/pi-ai");
const { TuiAltScreen, Text, visibleWidth } = await import("@earendil-works/pi-tui");
const execute = promisify(execFile);
const settle = () => new Promise((resolve) => setTimeout(resolve, 45));
async function until(predicate) {
	const deadline = Date.now() + 3000;
	while (!predicate()) {
		assert.ok(Date.now() < deadline, "Timed out waiting for asynchronous pane update");
		await settle();
	}
}

function terminal(columns = 140, rows = 40) {
	let input = () => {},
		resize = () => {};
	const output = [];
	return {
		columns,
		rows,
		output,
		kittyProtocolActive: false,
		start(callback, resized) {
			input = callback;
			resize = resized;
		},
		stop() {},
		async drainInput() {},
		write(data) {
			output.push(data);
		},
		moveBy() {},
		hideCursor() {},
		showCursor() {},
		clearLine() {},
		clearFromCursor() {},
		clearScreen() {},
		setTitle() {},
		setProgress() {},
		input(data) {
			input(data);
		},
		resize(columns, rows) {
			this.columns = columns;
			this.rows = rows;
			resize();
		},
	};
}
async function directory(t) {
	const path = await mkdtemp(join(tmpdir(), "pi-workspace-test-"));
	t.after(() => rm(path, { recursive: true, force: true }));
	return path;
}
function frame(tui) {
	return tui.currentLayout.lines.map(stripVTControlCharacters);
}
async function capture(app, name) {
	if (!process.env.PI_WORKSPACE_CAPTURE) return;
	await mkdir(process.env.PI_WORKSPACE_CAPTURE, { recursive: true });
	await writeFile(
		join(process.env.PI_WORKSPACE_CAPTURE, `${name}.json`),
		JSON.stringify({
			columns: app.tui.terminal.columns,
			rows: app.tui.terminal.rows,
			lines: app.tui.currentLayout.lines,
		}),
	);
}

test("native fullscreen layout allocates a persistent 40% pane and scrolls independently", async (t) => {
	sdk.initTheme("dark", false);
	const term = terminal();
	const tui = new TuiAltScreen(term);
	const reader = new Reader(workspaceTheme(), () => tui.requestRender());
	const layout = new WorkspaceLayout(tui, reader, workspaceTheme());
	layout.chat.addChild(
		new Text(Array.from({ length: 200 }, (_, i) => `Chat ${i}`).join("\n"), 0, 0),
	);
	layout.editor.addChild(new Text("Draft stays here", 0, 0));
	reader.set(
		Array.from({ length: 200 }, (_, i) => `const value${i} = ${i};`).join("\n"),
		"fixture.ts",
	);
	tui.start();
	t.after(() => tui.stop());
	await settle();
	assert.equal(layout.readerScroll.viewportHeight, 40);
	const lines = frame(tui);
	assert.equal(lines[0].indexOf("│"), 83);
	assert.ok(lines.every((line) => visibleWidth(line) <= term.columns));
	const chatTop = layout.transcript.scrollTop;
	term.input("\x1b[<65;110;10M");
	await settle();
	assert.ok(layout.readerScroll.scrollTop > 0);
	assert.equal(layout.transcript.scrollTop, chatTop);
	assert.match(frame(tui).join("\n"), /Draft stays here/);
	const readerTop = layout.readerScroll.scrollTop;
	term.input("\x1b[<64;5;10M");
	await settle();
	assert.ok(layout.transcript.scrollTop < chatTop);
	assert.equal(layout.readerScroll.scrollTop, readerTop);
	term.input("\x1b[<0;84;10M");
	term.input("\x1b[<32;70;10M");
	term.input("\x1b[<0;70;10m");
	await settle();
	assert.equal(layout.widthPercent, 51);
	assert.ok(frame(tui).every((line) => visibleWidth(line) <= term.columns));
});

test("reader search, Unicode, horizontal scroll and change navigation use native clipping", async (t) => {
	sdk.initTheme("dark", false);
	const term = terminal(100, 24);
	const tui = new TuiAltScreen(term);
	const reader = new Reader(workspaceTheme(), () => tui.requestRender());
	const layout = new WorkspaceLayout(tui, reader, workspaceTheme());
	reader.set(
		"@@ -1 +1 @@\n-old\n+new 🧪\n" + "context\n".repeat(30) + "@@ -40 +40 @@\n+second",
		"a.ts",
		true,
	);
	tui.start();
	t.after(() => tui.stop());
	await settle();
	reader.search("second");
	await settle();
	assert.ok(layout.readerScroll.scrollTop > 0);
	assert.equal(reader.searchStatus, "1/1 matches");
	reader.goTo(1);
	await settle();
	reader.nextHunk(1);
	await settle();
	assert.ok(layout.readerScroll.scrollTop > 0);
	reader.handleInput("\x1b[C");
	await settle();
	assert.ok(frame(tui).every((line) => visibleWidth(line) <= term.columns));
});

test("Git reader includes staged, unstaged, untracked, renamed and deleted content without changing files", async (t) => {
	const cwd = await directory(t);
	const git = (...args) => execute("git", ["-C", cwd, ...args], { windowsHide: true });
	await git("init", "--quiet");
	await git("config", "user.name", "Fixture");
	await git("config", "user.email", "fixture@example.invalid");
	await writeFile(join(cwd, "original.txt"), "before\n");
	await writeFile(join(cwd, "delete.txt"), "gone\n");
	await git("add", ".");
	await git("commit", "--quiet", "-m", "fixture");
	await git("mv", "original.txt", "renamed file.txt");
	await writeFile(join(cwd, "renamed file.txt"), "after\n");
	await git("rm", "delete.txt");
	await writeFile(join(cwd, "unicode 🧪.txt"), "new\n");
	const repository = new FileRepository(cwd);
	const changes = await repository.changes();
	const renamed = changes.find((change) => change.path.endsWith("renamed file.txt"));
	assert.ok(renamed.previousPath.endsWith("original.txt"));
	const before = (await git("status", "--porcelain=v1", "-z")).stdout;
	assert.match(await repository.diff(renamed.path, renamed.previousPath), /-before\n\+after/);
	assert.match(await repository.diff(join(cwd, "delete.txt")), /-gone/);
	assert.match(await repository.diff(join(cwd, "unicode 🧪.txt")), /\+new/);
	assert.equal((await git("status", "--porcelain=v1", "-z")).stdout, before);
	assert.equal((await readDocument(join(cwd, "renamed file.txt"))).text, "after\n");
});

test("unborn repository and unusual file names are read as literal paths", async (t) => {
	const cwd = await directory(t);
	await execute("git", ["-C", cwd, "init", "--quiet"], { windowsHide: true });
	const path = join(cwd, "--argument.txt");
	await writeFile(path, "hello\n");
	assert.match(await new FileRepository(cwd).diff(path), /\+hello/);
	assert.equal(fileLocation('"C:/code/file.ts:23"', cwd).line, 23);
	await writeFile(join(cwd, "binary"), Buffer.from([1, 0, 2]));
	assert.equal((await readDocument(join(cwd, "binary"))).binary, true);
});

async function application(t, extension, provider, bundle = false, columns = 140) {
	const cwd = await mkdtemp(join(tmpdir(), "pi-workspace-test-"));
	const agentDir = join(cwd, "agent");
	await mkdir(agentDir);
	const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const root = new URL("../", import.meta.url);
	const manifest = bundle
		? JSON.parse(await readFile(new URL("package.json", root), "utf8"))
		: undefined;
	const { fileURLToPath } = await import("node:url");
	const bus = sdk.createEventBus();
	const factory = async ({ cwd, sessionManager, sessionStartEvent }) => {
		const modelRuntime = await sdk.ModelRuntime.create({
			credentials: new ai.InMemoryCredentialStore(),
			modelsPath: null,
			modelsStorePath: join(agentDir, "models-store.json"),
			refreshOnCreate: false,
		});
		if (provider) modelRuntime.registerProvider("workspace-fixture", provider);
		const services = await sdk.createAgentSessionServices({
			cwd,
			agentDir,
			modelRuntime,
			settingsManager: sdk.SettingsManager.inMemory({}),
			resourceLoaderOptions: {
				eventBus: bus,
				noExtensions: !bundle,
				additionalExtensionPaths: manifest?.pi.extensions.map((path) =>
					fileURLToPath(new URL(path, root)),
				),
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
				extensionFactories: extension ? [extension] : [],
			},
		});
		assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
		return {
			...(await sdk.createAgentSessionFromServices({
				services,
				sessionManager,
				sessionStartEvent,
				...(provider
					? { model: modelRuntime.getModel("workspace-fixture", "fixture"), thinkingLevel: "xhigh" }
					: {}),
			})),
			services,
			diagnostics: services.diagnostics,
		};
	};
	const runtime = await sdk.createAgentSessionRuntime(factory, {
		cwd,
		agentDir,
		sessionManager: sdk.SessionManager.inMemory(cwd),
	});
	const term = terminal(columns);
	const app = new WorkspaceApp(runtime, bus, agentDir, term);
	t.after(async () => {
		try {
			await app.close();
		} finally {
			if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
			await rm(cwd, { recursive: true, force: true });
		}
	});
	await app.start();
	await settle();
	return { app, cwd, agentDir, term, bus };
}

test("actual Pi SDK mounts extension widgets on the right and reloads each lifecycle once", async (t) => {
	let starts = 0,
		stops = 0,
		calls = 0;
	const { app, term } = await application(t, (pi) => {
		pi.on("session_start", (_event, ctx) => {
			starts++;
			ctx.ui.setWidget("fixture", ["Goal · active", "Subagents · running"]);
		});
		pi.on("session_shutdown", () => {
			stops++;
		});
		pi.registerCommand("fixture", {
			description: "Local fixture",
			handler: async (_args, ctx) => {
				calls++;
				ctx.ui.setWidget("fixture", ["Goal · complete", "Subagents · done"]);
			},
		});
	});
	assert.equal(starts, 1);
	let lines = frame(app.tui);
	const goal = lines.find((line) => line.includes("Goal · active"));
	assert.ok(goal.indexOf("Goal") > 83);
	app.editor.setText("draft");
	term.input("!");
	assert.equal(app.editor.getText(), "draft!");
	await app.submit("/fixture");
	await settle();
	assert.equal(calls, 1);
	assert.match(frame(app.tui).join("\n"), /Goal · complete/);
	await app.submit("/reload");
	await settle();
	assert.equal(starts, 2);
	assert.equal(stops, 1);
	await app.submit("/fixture");
	assert.equal(calls, 2);
});

test("dialog cancellation, rejection and queuing preserve the draft and dispose components", async (t) => {
	const { app } = await application(t);
	app.editor.setText("keep draft");
	let done,
		disposed = 0;
	const first = app.ui.context.custom((_tui, _theme, _keys, finish) => {
		done = finish;
		return {
			render: () => ["First question"],
			invalidate() {},
			dispose() {
				disposed++;
			},
		};
	});
	let secondCreated = false;
	const second = app.ui.context.custom((_tui, _theme, _keys, finish) => {
		secondCreated = true;
		finish("second");
		return new Text("second");
	});
	await settle();
	assert.equal(secondCreated, false);
	done("first");
	assert.equal(await first, "first");
	assert.equal(await second, "second");
	assert.equal(disposed, 1);
	await assert.rejects(
		app.ui.context.custom(() => {
			throw Error("fixture rejection");
		}),
		/fixture rejection/,
	);
	assert.equal(app.editor.getText(), "keep draft");
	const controller = new AbortController();
	const question = app.ui.context.input("Cancel me", undefined, { signal: controller.signal });
	await settle();
	controller.abort();
	assert.equal(await question, undefined);
	assert.equal(app.tui.getFocusedComponent(), app.editor);
});

test("unknown commands never become inference and launch options do not change saved settings", async (t) => {
	const { app, agentDir } = await application(t);
	await assert.rejects(app.submit("/not-a-command"), /Unknown workspace command/);
	assert.equal(app.session.messages.length, 0);
	assert.throws(() => launchOptions(["--session", "x", "--continue"]), /Choose one/);
	assert.throws(() => launchOptions(["--session"]), /requires a value/);
	assert.equal(
		await readFile(join(agentDir, "settings.json"), "utf8").catch((error) => error.code),
		"ENOENT",
	);
});

test("terminal resizing switches to a reachable single pane and returns to the configured split", async (t) => {
	const { app, term } = await application(t);
	app.editor.setText("draft");
	term.resize(60, 24);
	await settle();
	assert.ok(frame(app.tui).every((line) => visibleWidth(line) <= 60));
	assert.match(frame(app.tui).join("\n"), /draft/);
	term.input("\x1b[17~");
	await settle();
	assert.doesNotMatch(frame(app.tui).join("\n"), /draft/);
	term.input("\x1b[17~");
	await settle();
	assert.match(frame(app.tui).join("\n"), /draft/);
	term.resize(160, 45);
	await settle();
	assert.equal(frame(app.tui)[0].indexOf("│"), 95);
	assert.ok(frame(app.tui).every((line) => visibleWidth(line) <= 160));
});

test("actual SDK streaming and tool execution preserve effort, draft, extension events and the reader", async (t) => {
	let requests = 0;
	const efforts = [];
	let file;
	const provider = {
		name: "Fixture",
		api: "openai-responses",
		apiKey: "synthetic-only",
		baseUrl: "https://example.invalid",
		models: [
			{
				id: "fixture",
				name: "Fixture",
				reasoning: true,
				thinkingLevelMap: {
					off: null,
					minimal: "low",
					low: "low",
					medium: "medium",
					high: "high",
					xhigh: "xhigh",
				},
				input: ["text"],
				contextWindow: 272000,
				maxTokens: 128000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			},
		],
		streamSimple(model, _context, options) {
			efforts.push(options.reasoning);
			requests++;
			const stream = ai.createAssistantMessageEventStream();
			const message = {
				role: "assistant",
				api: model.api,
				provider: model.provider,
				model: model.id,
				content:
					requests === 1
						? [{ type: "toolCall", id: "fixture_read", name: "read", arguments: { path: file } }]
						: [{ type: "text", text: "Read the fixture successfully." }],
				stopReason: requests === 1 ? "toolUse" : "stop",
				timestamp: Date.now(),
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			};
			queueMicrotask(() => {
				stream.push({ type: "start", partial: message });
				stream.push({ type: "done", reason: message.stopReason, message });
				stream.end();
			});
			return stream;
		},
	};
	const { app, cwd } = await application(t, undefined, provider);
	file = join(cwd, "example.ts");
	await writeFile(file, "export const fixture = 42;\n");
	const prompt = app.submit("Read the synthetic fixture.");
	app.editor.setText("next draft");
	await prompt;
	await settle();
	assert.equal(requests, 2);
	assert.deepEqual(efforts, ["xhigh", "xhigh"]);
	assert.equal(app.editor.getText(), "next draft");
	await until(() => /fixture = 42/.test(frame(app.tui).join("\n")));
	assert.match(frame(app.tui).join("\n"), /Read the fixture successfully/);
	assert.ok(app.session.messages.some((message) => message.role === "toolResult"));
});

test("right pane keyboard paging and initial line reveal leave transcript and editor untouched", async (t) => {
	const { app, cwd, term } = await application(t);
	const file = join(cwd, "long.ts");
	await writeFile(file, Array.from({ length: 250 }, (_, i) => `line ${i + 1}`).join("\n"));
	app.layout.chat.addChild(new Text("transcript\n".repeat(100), 0, 0));
	await app.panels.open(file, false, 100);
	await settle();
	assert.equal(app.layout.readerScroll.scrollTop, 99);
	app.editor.setText("keep draft");
	app.tui.setFocus(app.reader);
	const chat = app.layout.transcript.scrollTop;
	term.input("\x1b[6~");
	await settle();
	assert.ok(app.layout.readerScroll.scrollTop > 99);
	assert.equal(app.layout.transcript.scrollTop, chat);
	assert.equal(app.editor.getText(), "keep draft");
	const position = app.layout.readerScroll.scrollTop;
	await app.submit("/reload");
	await settle();
	assert.equal(app.layout.readerScroll.scrollTop, position);
	assert.match(frame(app.tui).join("\n"), /long.ts/);
});

test("extension view leases expire and background updates cannot replace an unanswered prompt", async (t) => {
	let workspace;
	const { app, cwd } = await application(t, (pi) => {
		pi.on("session_start", () => {
			workspace = getWorkspace(pi);
		});
	});
	assert.ok(workspace);
	let disposed = 0;
	const old = workspace.registerView("fixture", "Fixture", () => ({
		render: () => ["Old view"],
		invalidate() {},
		dispose() {
			disposed++;
		},
	}));
	old.show();
	await settle();
	assert.match(frame(app.tui).join("\n"), /Old view/);
	const current = workspace.registerView("fixture", "Fixture", () => new Text("New view"));
	old.dispose();
	current.show();
	await settle();
	assert.equal(disposed, 1);
	assert.match(frame(app.tui).join("\n"), /New view/);
	const file = join(cwd, "watched.txt");
	await writeFile(file, "before");
	await app.panels.open(file);
	const question = app.ui.context.input("Pending approval");
	await settle();
	await writeFile(file, "after");
	await app.panels.open(file);
	current.show();
	await settle();
	assert.match(frame(app.tui).join("\n"), /Pending approval/);
	assert.doesNotMatch(frame(app.tui).join("\n"), /New view/);
	app.tui.getFocusedComponent().handleInput("\x1b");
	assert.equal(await question, undefined);
	await settle();
	assert.match(frame(app.tui).join("\n"), /after/);
	const expired = workspace;
	await app.submit("/reload");
	expired.registerView("stale", "Stale", () => {
		throw Error("Expired factory must not run");
	});
	old.show();
	current.show();
	await settle();
	assert.doesNotMatch(frame(app.tui).join("\n"), /New view/);
});

test("custom footer, header, indicator, live overlay sizing and dialog input use native contracts", async (t) => {
	const { app, term } = await application(t);
	app.ui.context.setHeader(() => new Text("Workspace header"));
	app.ui.context.setFooter(() => new Text("Workspace footer"));
	app.renderStatus();
	await settle();
	assert.match(frame(app.tui).join("\n"), /Workspace header/);
	assert.match(frame(app.tui).join("\n"), /Workspace footer/);
	app.ui.context.setWorkingIndicator({ frames: ["A", "B"], intervalMs: 1000 });
	assert.equal(app.ui.indicator, "A");
	app.ui.context.setWorkingIndicator({ frames: [] });
	assert.equal(app.ui.indicator, "");
	const prompt = app.ui.context.input("Native input");
	await settle();
	term.input("answer");
	term.input("\r");
	assert.equal(await prompt, "answer");
	let finish, handle;
	const overlay = app.ui.context.custom(
		(_tui, _theme, _keys, done) => {
			finish = done;
			return new Text("Overlay");
		},
		{
			overlay: true,
			overlayOptions: () => ({ width: term.columns / 2 }),
			onHandle: (value) => {
				handle = value;
			},
		},
	);
	await settle();
	assert.equal(handle.getBounds().width, 70);
	term.resize(160, 40);
	await settle();
	assert.equal(handle.getBounds().width, 80);
	finish();
	await overlay;
});

test("SDK host HTTP setup enforces local idle deadlines, cancellation and restores globals", async (t) => {
	const server = createServer((request, response) => {
		if (request.url === "/headers") return;
		response.writeHead(200, { "content-type": "text/plain" });
		response.write("started");
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	t.after(() => {
		server.closeAllConnections();
		server.close();
	});
	const url = `http://127.0.0.1:${server.address().port}`;
	const previous = {
		fetch: globalThis.fetch,
		Response: globalThis.Response,
		noProxy: process.env.NO_PROXY,
	};
	process.env.NO_PROXY = "127.0.0.1";
	const http = new WorkspaceHttp();
	t.after(async () => {
		await http.dispose();
		if (previous.noProxy === undefined) delete process.env.NO_PROXY;
		else process.env.NO_PROXY = previous.noProxy;
	});
	http.configure(sdk.SettingsManager.inMemory({ httpIdleTimeoutMs: 60 }));
	await assert.rejects(
		fetch(`${url}/headers`),
		(error) => error.cause?.code === "UND_ERR_HEADERS_TIMEOUT",
	);
	const response = await fetch(`${url}/body`);
	await assert.rejects(response.text(), (error) => error.cause?.code === "UND_ERR_BODY_TIMEOUT");
	const controller = new AbortController();
	const pending = fetch(`${url}/headers`, { signal: controller.signal });
	controller.abort();
	await assert.rejects(pending, { name: "AbortError" });
	await http.dispose();
	assert.equal(globalThis.fetch, previous.fetch);
	assert.equal(globalThis.Response, previous.Response);
});

test("the complete manifest starts, renders Work, reloads and shuts down in the SDK frontend without inference", async (t) => {
	const originalFetch = globalThis.fetch;
	let network = 0;
	globalThis.fetch = async () => {
		network++;
		throw Error("No network allowed in frontend fixture");
	};
	t.after(() => {
		globalThis.fetch = originalFetch;
	});
	const { app, cwd, term } = await application(t, undefined, undefined, true);
	assert.equal(app.session.resourceLoader.getExtensions().extensions.length, 21);
	assert.ok(app.session.extensionRunner.getCommand("codex-wire"));
	assert.ok(app.session.extensionRunner.getCommand("subagents"));
	const { ensureWorkUi } = await import("../pi-work-ui/index.ts");
	const ui = ensureWorkUi({ events: app.bus });
	ui.source("goal").set({
		label: "Goal",
		summary: "Build workspace",
		status: "active",
		detail: "Reader and diff panels",
	});
	ui.source("todos").set({
		label: "Todos",
		summary: "2 of 3 complete",
		status: "1 remaining",
		detail: "✓ Read files\n✓ Review changes\n○ Verify the final result",
	});
	ui.source("subagents").set({
		label: "Subagents",
		summary: "Reviewer",
		status: "idle",
		detail: "No active child processes.",
	});
	app.panels.select("work");
	await settle();
	assert.match(frame(app.tui).join("\n"), /Goal/);
	ui.toggle("goal");
	ui.toggle("todos");
	if (process.env.PI_WORKSPACE_CAPTURE) {
		app.transcript.restore([
			{
				type: "message",
				message: {
					role: "user",
					content: "Review the division helper and show me the changes.",
					timestamp: Date.now(),
				},
			},
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{
							type: "text",
							text: 'The helper now rejects a zero divisor before dividing.\n\nThe diff is open beside the conversation. Use the **Work** tab to check the goal and remaining tasks; your draft stays in the editor.\n\n```ts\nif (b === 0) throw new Error("Divisor is zero");\nreturn a / b;\n```',
						},
					],
					api: "openai-responses",
					provider: "workspace-fixture",
					model: "fixture",
					stopReason: "stop",
					timestamp: Date.now(),
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				},
			},
		]);
		app.notify("");
		app.editor.setText("Check the boundary cases next.");
	}
	await settle();
	await capture(app, "work");
	if (process.env.PI_WORKSPACE_CAPTURE) {
		const file = join(cwd, "example.ts");
		await execute("git", ["-C", cwd, "init", "--quiet"], { windowsHide: true });
		await writeFile(
			file,
			'export function divide(a: number, b: number) {\n  if (b === 0) throw new Error("Divisor is zero");\n  return a / b;\n}\n',
		);
		app.editor.setText("Review this change and explain the behavior.");
		await app.panels.open(file, true);
		await settle();
		await capture(app, "diff");
		term.resize(100, 28);
		await settle();
		await capture(app, "compact");
	}
	await app.submit("/reload");
	await settle();
	assert.equal(app.session.resourceLoader.getExtensions().extensions.length, 21);
	await app.close();
	assert.equal(network, 0);
});

test("SDK session replacement and fork retire pane state without rewriting the parent", async (t) => {
	let starts = 0;
	const { app, cwd, agentDir } = await application(t, (pi) => {
		pi.on("session_start", () => {
			starts++;
		});
	});
	const manager = sdk.SessionManager.create(cwd, join(agentDir, "sessions"));
	const first = manager.appendMessage({
		role: "user",
		content: "First fixture",
		timestamp: Date.now(),
	});
	manager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "Fixture reply" }],
		api: "openai-responses",
		provider: "workspace-fixture",
		model: "fixture",
		stopReason: "stop",
		timestamp: Date.now(),
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	});
	manager.appendMessage({ role: "user", content: "Second fixture", timestamp: Date.now() });
	const path = manager.getSessionFile();
	const before = await readFile(path);
	await app.runtime.switchSession(path);
	await settle();
	assert.equal(starts, 2);
	assert.match(frame(app.tui).join("\n"), /First fixture/);
	const beforeFork = await readFile(path);
	assert.deepEqual(beforeFork.subarray(0, before.length), before);
	await app.runtime.fork(first, { position: "at" });
	await settle();
	assert.equal(starts, 3);
	assert.notEqual(app.session.sessionId, manager.getSessionId());
	assert.deepEqual(await readFile(path), beforeFork);
	await app.submit("/new");
	await settle();
	assert.equal(starts, 4);
	assert.doesNotMatch(frame(app.tui).join("\n"), /First fixture/);
});

test("narrow startup and background following keep the visible editor focused", async (t) => {
	const { app, cwd, term } = await application(t, undefined, undefined, false, 60);
	app.editor.setText("Visible draft");
	app.tui.requestRender();
	await settle();
	assert.match(frame(app.tui).join("\n"), /Visible draft/);
	assert.equal(app.tui.getFocusedComponent(), app.editor);
	const file = join(cwd, "narrow.ts");
	await writeFile(file, "const visible = true;");
	await app.panels.followFiles([file], false);
	await settle();
	assert.match(frame(app.tui).join("\n"), /Visible draft/);
	await app.panels.open(file);
	await settle();
	assert.equal(app.tui.getFocusedComponent(), app.reader);
	assert.match(frame(app.tui).join("\n"), /const visible/);
	term.input("\x1b");
	await settle();
	assert.match(frame(app.tui).join("\n"), /Visible draft/);
	await app.submit("/help");
	await settle();
	const scroll = app.tui.getFocusedComponent();
	term.input("\x1b[6~");
	await settle();
	assert.ok(scroll.scrollTop > 0);
	const image = join(cwd, "quoted image.PNG");
	await writeFile(
		image,
		Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aTn0AAAAASUVORK5CYII=",
			"base64",
		),
	);
	await app.submit(`/attach "${image}"`);
	app.layout.focusChat();
	app.tui.setFocus(app.editor);
	await settle();
	assert.match(frame(app.tui).join("\n"), /1 image/);
});
