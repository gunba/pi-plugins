import test, { after } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { channel } from "node:diagnostics_channel";
import { createRequire } from "node:module";
import { HttpNetworkTrace, networkErrorCodes, responseRequestIds, diagnosticEventType } from "../extensions/network-diagnostics.ts";

// Use Pi's actual HTTP dispatcher/fetch installation, not just Node's built-in fetch.
const host = import.meta.resolve("@earendil-works/pi-coding-agent");
const { configureHttpDispatcher } = await import(new URL("./core/http-dispatcher.js", host));
configureHttpDispatcher(5000);
after(() => createRequire(host)("undici").getGlobalDispatcher().close());

const channels = ["undici:request:create", "undici:client:sendHeaders", "undici:request:bodySent",
  "undici:request:headers", "undici:request:error"].map(channel);
const subscriptions = () => channels.map(value => value.hasSubscribers);
function deferred() { let resolve; const promise = new Promise(value => { resolve = value; }); return { promise, resolve }; }
async function fixture(t, handler) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}/responses`;
}

test("native HTTP trace separates upload from delayed headers without changing content", { timeout: 10_000 }, async t => {
  const received = deferred(), sent = deferred(), rows = [];
  const url = await fixture(t, (req, res) => {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      assert.equal(Buffer.concat(chunks).toString(), "PRIVATE_REQUEST");
      received.resolve(res);
    });
  });
  const baseline = subscriptions();
  const trace = new HttpNetworkTrace({ write: row => { rows.push(row); if (row.stage === "body-sent") sent.resolve(); } },
    { requestId: "fixture" }, url);
  const result = trace.run(() => fetch(url, {
    method: "POST", body: "PRIVATE_REQUEST", headers: { authorization: "PRIVATE_AUTH" },
  }), new AbortController().signal);
  const [res] = await Promise.all([received.promise, sent.promise]);
  assert.deepEqual(rows.map(row => row.stage), ["request-created", "headers-ready", "body-sent"]);
  res.end("PRIVATE_RESPONSE");
  assert.equal(await (await result).text(), "PRIVATE_RESPONSE");
  assert.deepEqual(rows.map(row => row.stage), ["request-created", "headers-ready", "body-sent", "response-headers", "fetch-returned"]);
  assert.deepEqual(subscriptions(), baseline);
  assert.doesNotMatch(JSON.stringify(rows), /PRIVATE|127\.0\.0\.1|authorization/);
});

test("concurrent requests, nested non-inference fetches and reversed completions remain separate", { timeout: 10_000 }, async t => {
  const ready = deferred();
  const url = await fixture(t, (req, res) => {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      if (req.url !== "/responses" || req.method !== "POST") { res.writeHead(204); res.end(); return; }
      if (Buffer.concat(chunks).toString() === "A") ready.resolve(res);
      else { res.writeHead(202); res.end("B"); }
    });
  });
  const a = [], b = [], baseline = subscriptions();
  const traceA = new HttpNetworkTrace({ write: row => a.push(row) }, { requestId: "A" }, url);
  const traceB = new HttpNetworkTrace({ write: row => b.push(row) }, { requestId: "B" }, url);
  const signal = new AbortController().signal;
  const first = traceA.run(async () => {
    await fetch(`${url}/metadata`, { method: "POST", body: "UNRELATED" });
    return fetch(url, { method: "POST", body: "A" });
  }, signal);
  const resA = await ready.promise;
  await fetch(url);
  assert.equal(await (await traceB.run(() => fetch(url, { method: "POST", body: "B" }), signal)).text(), "B");
  assert.equal(a.some(row => row.stage === "response-headers"), false);
  resA.writeHead(201); resA.end("A");
  assert.equal(await (await first).text(), "A");
  assert.equal(a.find(row => row.stage === "response-headers").status, 201);
  assert.equal(b.find(row => row.stage === "response-headers").status, 202);
  assert.deepEqual(subscriptions(), baseline);
});

test("aborted header waits detach observers and do not retry", { timeout: 10_000 }, async t => {
  const received = deferred(), rows = [];
  let requests = 0;
  const url = await fixture(t, req => {
    requests++; req.resume(); req.on("end", received.resolve);
  });
  const baseline = subscriptions();
  const controller = new AbortController();
  const trace = new HttpNetworkTrace({ write: row => rows.push(row) }, { requestId: "abort" }, url);
  const result = trace.run(() => fetch(url, { method: "POST", body: "fixture", signal: controller.signal }), controller.signal);
  await received.promise; controller.abort();
  await assert.rejects(result, { name: "AbortError" });
  assert.equal(requests, 1);
  assert.equal(rows.some(row => row.stage === "aborted"), true);
  assert.equal(rows.some(row => row.stage === "response-headers"), false);
  assert.deepEqual(subscriptions(), baseline);
});

test("failed or custom fetchers and failing observers do not change request outcomes", async () => {
  const baseline = subscriptions(), rows = [];
  const error = new TypeError("PRIVATE_ERROR", { cause: Object.assign(new Error("PRIVATE_CAUSE"), { code: "ECONNRESET" }) });
  const trace = new HttpNetworkTrace({ write: row => rows.push(row) }, { requestId: "error" }, "http://fixture.invalid/responses");
  await assert.rejects(trace.run(async () => { throw error; }, new AbortController().signal), value => value === error);
  assert.deepEqual(rows[0].errorCodes, ["ECONNRESET"]);
  assert.doesNotMatch(JSON.stringify(rows), /PRIVATE/);
  const throwing = new HttpNetworkTrace({ write() { throw new Error("observer"); } }, {}, "http://fixture.invalid/responses");
  const response = new Response("unchanged");
  assert.equal(await throwing.run(async () => response, new AbortController().signal), response);
  assert.deepEqual(subscriptions(), baseline);
});

test("diagnostic values exclude free text, credentials, routing state and unknown events", () => {
  const error = { code: "PRIVATE_CODE", message: "PRIVATE_MESSAGE" };
  error.cause = error;
  assert.deepEqual(networkErrorCodes(error), []);
  assert.deepEqual(responseRequestIds(new Headers({
    "x-request-id": "req_fixture", "cf-ray": "abcd-PER", "x-openai-request-id": "PRIVATE SPACE VALUE",
    authorization: "PRIVATE_AUTH", "chatgpt-account-id": "PRIVATE_ACCOUNT", "x-codex-turn-state": "PRIVATE_ROUTE",
  })), { "x-request-id": "req_fixture", "cf-ray": "abcd-PER" });
  assert.equal(diagnosticEventType({ type: "response.reasoning_summary_text.delta" }), "response.reasoning_summary_text.delta");
  assert.equal(diagnosticEventType({ type: "PRIVATE_EVENT" }), "other");
});
