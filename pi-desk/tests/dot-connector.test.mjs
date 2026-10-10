import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PartyStore } from "../../pi-party/store.ts";
import { DotConnector } from "../src/host/dot-connector.ts";

const base = "https://relay.example/connector/11111111-1111-1111-1111-111111111111";
const callback = "https://chatgpt.com/connector_platform_oauth_redirect";

test("ChatGPT reaches agents only through an OAuth grant approved in Desk", async t => {
	const dir = mkdtempSync(join(tmpdir(), "dot-connector-")), store = new PartyStore(join(dir, "party"));
	const connector = new DotConnector(dir, store, "fedora");
	t.after(() => { connector.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
	const send = (method, path, { query = "", body = "", headers = {} } = {}) => connector.handle({ method, path, query, headers, body }, base);
	const parse = response => JSON.parse(response.body);
	assert.equal((await send("GET", "/.well-known/oauth-authorization-server")).status, 404, "off until Jordan enables it");
	connector.enable();

	const resource = parse(await send("GET", "/.well-known/oauth-protected-resource"));
	assert.deepEqual(resource.authorization_servers, [base]);
	const server = parse(await send("GET", "/.well-known/oauth-authorization-server"));
	assert.equal(server.token_endpoint, `${base}/token`);
	assert.deepEqual(server.code_challenge_methods_supported, ["S256"]);
	const unauthorized = await send("POST", "", { body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
	assert.equal(unauthorized.status, 401);
	assert.equal(unauthorized.headers["www-authenticate"], 'Bearer resource_metadata="https://relay.example/.well-known/oauth-protected-resource/connector/11111111-1111-1111-1111-111111111111"');

	assert.equal((await send("POST", "/register", { body: JSON.stringify({ redirect_uris: ["https://evil.example/cb"] }) })).status, 400, "only ChatGPT callbacks");
	const client = parse(await send("POST", "/register", { body: JSON.stringify({ client_name: "ChatGPT", redirect_uris: [callback] }) }));
	const verifier = randomBytes(32).toString("base64url"), challenge = createHash("sha256").update(verifier).digest("base64url");
	const query = new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: callback, state: "s1",
		code_challenge: challenge, code_challenge_method: "S256" }).toString();
	const waiting = await send("GET", "/authorize", { query });
	assert.equal(waiting.status, 200);
	assert.match(waiting.body, /http-equiv="refresh"/);
	const [approval] = connector.approvals();
	assert.equal(approval.redirect, "chatgpt.com");
	assert.ok(waiting.body.includes(approval.code), "the page shows the code Jordan compares in Desk");
	assert.equal((await send("GET", "/authorize", { query })).status, 200, "still waiting, same request");
	assert.equal(connector.approvals().length, 1);
	connector.decide(approval.id, true);
	const redirected = await send("GET", "/authorize", { query });
	assert.equal(redirected.status, 302);
	const location = new URL(redirected.headers.location);
	assert.equal(location.origin + location.pathname, callback);
	assert.equal(location.searchParams.get("state"), "s1");
	const code = location.searchParams.get("code");

	const exchange = form => send("POST", "/token", { body: new URLSearchParams(form).toString(), headers: { "content-type": "application/x-www-form-urlencoded" } });
	const grant = { grant_type: "authorization_code", client_id: client.client_id, redirect_uri: callback, code };
	assert.equal((await exchange({ ...grant, code_verifier: "wrong".repeat(10) })).status, 400, "PKCE is enforced");
	assert.equal((await exchange({ ...grant, code_verifier: verifier })).status, 400, "a code is single use, even after a failed attempt");

	// A second, correct authorization.
	const query2 = query.replace("state=s1", "state=s2");
	await send("GET", "/authorize", { query: query2 });
	connector.decide(connector.approvals()[0].id, true);
	const code2 = new URL((await send("GET", "/authorize", { query: query2 })).headers.location).searchParams.get("code");
	const tokens = parse(await exchange({ ...grant, code: code2, code_verifier: verifier }));
	assert.equal(tokens.token_type, "Bearer");
	assert.ok(!readFileSync(join(dir, "dot-connector.json"), "utf8").includes(tokens.access_token), "only hashes are stored");

	const rpc = async (method, params, token = tokens.access_token) => {
		const response = await send("POST", "", { body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), headers: { authorization: `Bearer ${token}` } });
		return response.status === 200 ? parse(response) : response;
	};
	const tool = async (name, args = {}) => JSON.parse((await rpc("tools/call", { name, arguments: args })).result.content[0].text);
	assert.equal((await rpc("initialize", { protocolVersion: "2025-06-18" })).result.serverInfo.name, "pi-desk");
	assert.deepEqual((await rpc("tools/list")).result.tools.map(item => item.name), ["list_agents", "message_agent", "read_messages"]);
	assert.equal((await rpc("tools/list", {}, tokens.refresh_token)).status, 401, "a refresh token is not an access token");

	store.register("worker", "worker-owner", "BD Workbook", "C:\\obsidian");
	store.register("child", "child-owner", "Untitled conversation", "C:\\obsidian", "child");
	assert.deepEqual((await tool("list_agents")).map(item => [item.name, item.computer]), [["BD Workbook", "fedora"]]);
	assert.equal((await tool("list_agents", { include_children: true })).length, 2);
	await tool("message_agent", { agent: "worker", message: "Status of the overnight run?" });
	const [received] = store.pending("worker", "worker-owner");
	assert.equal(received.sender_label, "Steve (Dot)");
	store.send("worker", "worker-owner", received.sender, "Round 23 is done.", false);
	assert.deepEqual((await tool("read_messages")).unread.map(item => [item.from, item.message]), [["BD Workbook", "Round 23 is done."]]);

	const refreshed = parse(await exchange({ grant_type: "refresh_token", client_id: client.client_id, refresh_token: tokens.refresh_token }));
	assert.ok(refreshed.access_token);
	assert.equal((await exchange({ grant_type: "refresh_token", client_id: client.client_id, refresh_token: tokens.refresh_token })).status, 400, "refresh tokens rotate");
	assert.equal((await rpc("ping", {}, refreshed.access_token)).result !== undefined, true);

	// Denial redirects with an error and issues nothing.
	const query3 = query.replace("state=s1", "state=s3");
	await send("GET", "/authorize", { query: query3 });
	connector.decide(connector.approvals()[0].id, false);
	assert.equal(new URL((await send("GET", "/authorize", { query: query3 })).headers.location).searchParams.get("error"), "access_denied");

	connector.disable();
	assert.equal((await rpc("ping", {}, refreshed.access_token)).status, 404, "turning access off revokes it");
	assert.equal(store.member(received.sender).heartbeat, 0);
});

test("upgrading from the secret-URL connector keeps the Dot's agent identity and revokes the URL", t => {
	const dir = mkdtempSync(join(tmpdir(), "dot-connector-upgrade-")), store = new PartyStore(join(dir, "party"));
	writeFileSync(join(dir, "dot-connector.json"), JSON.stringify({ format: 1, secret: "s".repeat(43), agent: "22222222-2222-2222-2222-222222222222", owner: "o" }));
	const connector = new DotConnector(dir, store, "fedora");
	t.after(() => { connector.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
	const saved = JSON.parse(readFileSync(join(dir, "dot-connector.json"), "utf8"));
	assert.equal(saved.format, 2);
	assert.equal(saved.secret, undefined);
	assert.equal(store.member("22222222-2222-2222-2222-222222222222").label, "Steve (Dot)");
});
