import assert from "node:assert/strict";
import test from "node:test";
import { openingMessage, sessionTitle } from "../src/shared/session-title.ts";
import { providerIdentity } from "../src/host/provider-identity.ts";
import { LiveNotices, deskStatus, dismissDeskStatus, reportDeskError, subscribeDeskStatus } from "../src/client/desk-status.ts";
import { clearSubmission, createSubmission, readSubmission, submissionDecision, submitWithReceipt } from "../src/client/input-submission.ts";
import { activityLabel, leadingActivity, sessionActivity } from "../src/client/activity.ts";

test("startup sends preserve normal steering and explicitly queued delivery", () => {
	for (const state of ["starting", "ready"]) for (const delivery of ["steer", "followUp"]) {
		const receipt = createSubmission({ activation: "worker", state, generation: "native" }, "draft", delivery);
		assert.equal(receipt.behavior, delivery, "opening Pi must not turn a normal send into an end-of-task follow-up");
		assert.equal(receipt.generation, state === "starting" ? undefined : "native");
		assert.equal(receipt.activation, "worker");
	}
});

test("closed conversations do not inherit old error activity and collapsed parties retain questions", () => {
	assert.equal(sessionActivity({ state: "closed", interrupted: true, snapshot: { activity: "error" } }), "closed");
	assert.equal(activityLabel(sessionActivity({ state: "failed", interrupted: true })), "Unavailable", "a lost worker connection does not prove the actor stopped");
	assert.equal(sessionActivity({ state: "ready", snapshot: { activity: "running" }, ui: { interactions: [{}] } }), "waiting");
	assert.equal(leadingActivity(["idle", "running", "waiting"]), "waiting");
	assert.equal(leadingActivity(["idle", "running"]), "running");
	assert.equal(leadingActivity(["closed", "closed"]), "closed");
});

test("lost input acknowledgements are reconciled before a resend warning", async () => {
	const receipt = { id: "receipt", activation: "old-worker", fingerprint: "earlier-draft" };
	for (const state of ["queued", "sending", "accepted"]) {
		const status = { id: receipt.id, state };
		assert.equal(submissionDecision(receipt, "old-worker", "new-draft", status), "new", "confirmed earlier input must not warn on a different message");
		assert.equal(submissionDecision(receipt, "old-worker", receipt.fingerprint, status), "confirmed", "lost reply must not cause another POST");
		assert.equal(submissionDecision(receipt, "new-worker", receipt.fingerprint, status), "confirmed", "a durable accepted receipt survives worker replacement");
	}
	for (const state of ["failed", "interrupted", "cancelled"]) {
		assert.equal(submissionDecision(receipt, "old-worker", receipt.fingerprint, { id: receipt.id, state }), "confirm");
	}
	assert.equal(submissionDecision(receipt, "new-worker", "new-draft"), "confirm", "missing evidence is not proof of failed delivery");
	assert.equal(submissionDecision(receipt, "old-worker", receipt.fingerprint), "reuse", "unconfirmed identical input retains its idempotency key");
	assert.equal(submissionDecision(receipt, "new-worker", "new-draft", { id: "other-receipt", state: "accepted" }), "confirm");

	const accepted = { id: receipt.id, state: "accepted" };
	for (const failure of [new TypeError("Failed to fetch"), Object.assign(new Error("Timed out"), { status: 504 })]) {
		let posts = 0, reads = 0;
		assert.equal(await submitWithReceipt(receipt, async () => { posts++; throw failure; }, async id => {
			reads++; assert.equal(id, receipt.id); return accepted;
		}), accepted);
		assert.equal(posts, 1, "a missing POST reply must only trigger a receipt read, never a retransmission");
		assert.equal(reads, 1);
		await assert.rejects(submitWithReceipt(receipt, async () => { throw failure; }, async () => { throw Error("Offline"); }), error => error === failure);
	}
	const conflict = Object.assign(new Error("Different contents"), { status: 409 });
	await assert.rejects(submitWithReceipt(receipt, async () => { throw conflict; }, async () => {
		assert.fail("a rejected payload cannot be confirmed by somebody else's receipt");
	}), error => error === conflict);
	assert.equal(await readSubmission(receipt, async () => ({ id: "other", state: "accepted" })), undefined);

	let marker = JSON.stringify({ id: "newer-message" });
	const storage = { getItem: () => marker, removeItem: () => { marker = null; } };
	assert.equal(clearSubmission(storage, "session", receipt.id), false);
	assert.ok(marker, "an older receipt cannot clear a newer draft's delivery marker");
	marker = JSON.stringify(receipt);
	assert.equal(clearSubmission(storage, "session", receipt.id), true);
	assert.equal(marker, null);
});

test("Desk storage errors use one transient status and do not become conversation feedback", () => {
	const browser = { id: "browser", text: "InvalidStateError: database connection is closing", level: "error", timestamp: 100, generation: "browser" };
	let notifications = 0;
	const unsubscribe = subscribeDeskStatus(() => notifications++);
	try {
		reportDeskError(browser.text);
		const status = deskStatus();
		assert.equal(status.text, "Local draft storage is temporarily unavailable.");
		assert.ok(status.expires > Date.now());
		reportDeskError(browser.text);
		assert.equal(deskStatus(), status);
		assert.equal(notifications, 1);
		dismissDeskStatus(status.id);
		assert.equal(deskStatus(), undefined);
	} finally { unsubscribe(); }
});

test("account picker distinguishes unavailable and changing selection from default credentials", async () => {
	const { build } = await import("esbuild");
	const { mkdtempSync, rmSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const { fileURLToPath } = await import("node:url");
	const { createRequire } = await import("node:module");
	const directory = mkdtempSync(join(tmpdir(), "desk-account-picker-"));
	try {
		const outfile = join(directory, "fixture.cjs");
		await build({ stdin: { resolveDir: fileURLToPath(new URL("../", import.meta.url)), loader: "tsx", contents: `
			import React from "react";
			import { renderToStaticMarkup } from "react-dom/server";
			import { ProviderAccountsPanel } from "./src/client/provider-accounts.tsx";
			import { ModelPicker } from "./src/client/model-picker.tsx";
			import { setOpen } from "./src/client/anchored-popover.ts";
			export const renderModel = (snapshot, open) => {
				setOpen(open);
				return renderToStaticMarkup(<ModelPicker snapshot={snapshot} disabled={false}
					select={()=>{throw Error('No model action');}} accounts={()=>{}} history={()=>{}}/>);
			};
			export const render = session => renderToStaticMarkup(<ProviderAccountsPanel host={{name:"Fixture",sessions:[]}}
				session={session} connected={true} busy={false} invoke={async()=>{throw Error('No account action');}}/>);
		` }, outfile, bundle: true, platform: "node", format: "cjs", jsx: "automatic", plugins: [{ name: "offline-connection", setup(builder) {
			builder.onResolve({ filter: /anchored-popover\.ts$/ }, () => ({ path: "popover", namespace: "fixture-popover" }));
			builder.onLoad({ filter: /.*/, namespace: "fixture-popover" }, () => ({ contents: `
				let open = false;
				export const setOpen = value => { open = value; };
				export const useAnchoredPopover = () => ({ id: 'fixture-menu', open,
					trigger: { current: null }, panel: { current: null }, close() {} });
			`, loader: "js" }));
			builder.onResolve({ filter: /surfaces\.tsx$/ }, () => ({ path: "surfaces", namespace: "fixture-modal" }));
			builder.onLoad({ filter: /.*/, namespace: "fixture-modal" }, () => ({ contents: "export function Modal() { throw Error('Unexpected modal'); }", loader: "js" }));
			builder.onResolve({ filter: /connection\.ts$/ }, () => ({ path: "connection", namespace: "fixture" }));
			builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: "export function api() { throw Error('No network'); }", loader: "js" }));
		} }] });
		const { render, renderModel } = createRequire(import.meta.url)(outfile);
		const model = { provider: "openai-codex", id: "codex", name: "Codex" };
		const snapshot = { id: "fixture", activity: "idle", model, accounts: { "openai-codex": "named-account" },
			models: [model, { provider: "anthropic", id: "claude", name: "Claude" }] };
		const closed = renderModel(snapshot, false);
		assert.match(closed, /aria-expanded="false"/);
		assert.doesNotMatch(closed, /role="option"|model-menu-list/);
		const olderWorker = renderModel(snapshot, true);
		assert.match(olderWorker, /aria-expanded="true"/);
		assert.match(olderWorker, /role="option"[^>]*aria-disabled="true"[^>]*>.*Claude/);
		assert.doesNotMatch(olderWorker, /<select|<details/);
		assert.match(olderWorker, /popover="auto"[^>]*class="model-menu"/);
		assert.match(olderWorker, /Saved account/);
		assert.doesNotMatch(olderWorker, /Pi credentials/);
		assert.match(olderWorker, /Restart this conversation when idle/);
		const currentWorker = renderModel({ ...snapshot, modelSwitchConstraint: null }, true);
		assert.doesNotMatch(currentWorker, /aria-disabled="true"/);
		assert.doesNotMatch(currentWorker, /Restart this conversation when idle/);
		const queue = { steering: { count: 0 }, followUp: { count: 0 } };
		const absent = render({ key: "fixture", state: "closed" });
		assert.match(absent, /value="" selected="">Account selection unavailable/);
		assert.doesNotMatch(absent, /value="pi" selected=""/);
		const confirmed = render({ key: "fixture", state: "ready", snapshot: { accounts: {}, queue } });
		assert.match(confirmed, /value="pi" selected=""/);
		const changing = render({ key: "fixture", state: "ready", snapshot: { accounts: {}, queue }, controls: [{ kind: "account", state: "running" }] });
		assert.match(changing, /value="" selected="">Changing account…/);
		assert.doesNotMatch(changing, /value="pi" selected=""/);
	} finally { rmSync(directory, { recursive: true, force: true }); }
});

test("opening conversations does not replay notifications; only fresh live notices surface once", () => {
	const notices = new LiveNotices();
	const old = { id: "old", level: "warning", text: "Using HTTPS", timestamp: 1_000 };
	const ui = { generation: "worker", notifications: [old] };
	assert.equal(notices.latest("one", ui, 2_000), undefined, "initial inventory is not a new event");
	const fresh = { ...old, id: "fresh", timestamp: 3_000 };
	ui.notifications.push(fresh);
	assert.equal(notices.latest("one", ui, 3_000), fresh);
	assert.equal(notices.latest("one", ui, 3_000), undefined);
	assert.equal(notices.latest("two", ui, 4_000), undefined);
	assert.equal(notices.latest("one", ui, 4_000), undefined, "returning must not replay the old session's alerts");
	ui.notifications.push({ ...fresh, id: "buffered" });
	assert.equal(notices.latest("one", ui, 30_000), undefined, "late snapshots must not replay buffered alerts");
	const error = { ...fresh, id: "error", level: "error", timestamp: 30_000 };
	ui.notifications.push(error, { ...fresh, id: "later-warning", timestamp: 30_000 });
	assert.equal(notices.latest("one", ui, 30_000), error, "one banner, with errors taking priority");
	assert.equal(notices.latest("one", ui, 30_000), undefined, "the rest of a batch must not queue behind it");
	assert.equal(notices.latest("one", { ...ui, generation: "new-worker" }, 30_000), undefined);
});
test("resuming unnamed history uses its opening user text without changing its native name", () => {
	const entries = [
		{ type: "message", message: { role: "assistant", content: "Not the name" } },
		{ type: "message", message: { role: "user", content: [{ type: "image" }, { type: "text", text: "  Build\n a calendar " }] } },
		{ type: "message", message: { role: "user", content: "Another message" } },
	];
	assert.equal(sessionTitle(undefined, openingMessage(entries)), "Build a calendar");
	assert.equal(sessionTitle("Calendar project", openingMessage(entries)), "Calendar project");
	assert.equal(sessionTitle(undefined, openingMessage([])), "New conversation");
});
test("model account labels expose identity, not OAuth credentials", () => {
	const jwt = claims => `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
	const access = jwt({ "https://api.openai.com/profile": { email: "person@example.test" },
		"https://api.openai.com/auth": { chatgpt_account_id: "workspace-1", chatgpt_plan_type: "pro" } });
	assert.equal(providerIdentity({ type: "oauth", access, refresh: "SECRET" }), "person@example.test · pro · Account workspace-1");
	assert.equal(providerIdentity({ type: "api_key", key: "SECRET" }), undefined);
	assert.equal(providerIdentity({ type: "oauth", access: "opaque", refresh: "SECRET" }), undefined);
	assert.equal(providerIdentity({ type: "oauth", accountId: "workspace-2" }), "Account workspace-2");
});
