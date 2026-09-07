import assert from "node:assert/strict";
import test from "node:test";
import { Catalog, resolveModelMetadata } from "../extensions/catalog.ts";
import { identity } from "./fixtures.mjs";

const url = "https://chatgpt.com/backend-api/codex/responses";
const id = "gpt-6-astra";
const headers = (account, credential = account) => new Headers({ authorization: `Bearer ${credential}`, "chatgpt-account-id": account });
const response = value => Response.json({ models: [{ slug: id, default_verbosity: value, service_tiers: [{ id: "priority" }], instructions: "PRIVATE INSTRUCTIONS" }] });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test("late account A response cannot replace account B's cached capabilities", async () => {
  const catalog = new Catalog(identity), a = deferred(), b = deferred();
  let calls = 0;
  const fetcher = (_url, options) => { calls++; return options.headers.get("chatgpt-account-id") === "A" ? a.promise : b.promise; };
  const requestA = catalog.model(id, url, headers("A"), undefined, fetcher);
  const requestB = catalog.model(id, url, headers("B"), undefined, fetcher);
  b.resolve(response("high")); assert.equal((await requestB).default_verbosity, "high");
  a.resolve(response("low")); assert.equal((await requestA).default_verbosity, "low");
  assert.equal((await catalog.model(id, url, headers("B"), undefined, fetcher)).default_verbosity, "high");
  assert.equal((await catalog.model(id, url, headers("A"), undefined, fetcher)).default_verbosity, "low");
  assert.equal(calls, 2);
});

test("endpoint and credential changes isolate caches even with the same account", async () => {
  const catalog = new Catalog(identity);
  let calls = 0;
  const fetcher = async () => response(String(++calls));
  assert.equal((await catalog.model(id, url, headers("A", "old"), undefined, fetcher)).default_verbosity, "1");
  assert.equal((await catalog.model(id, url, headers("A", "new"), undefined, fetcher)).default_verbosity, "2");
  assert.equal((await catalog.model(id, url.replace("chatgpt.com", "example.com"), headers("A", "new"), undefined, fetcher)).default_verbosity, "3");
  assert.equal((await catalog.model(id, url, headers("A", "old"), undefined, fetcher)).default_verbosity, "1");
});

test("same-scope races freeze the first successful snapshot and detach returned data", async () => {
  const catalog = new Catalog(identity), first = deferred(), second = deferred();
  let calls = 0;
  const fetcher = () => ++calls === 1 ? first.promise : second.promise;
  const slow = catalog.model(id, url, headers("A"), undefined, fetcher);
  const fast = catalog.model(id, url, headers("A"), undefined, fetcher);
  second.resolve(response("high")); const result = await fast;
  result.service_tiers[0].id = "corrupted";
  first.resolve(response("low"));
  assert.equal((await slow).default_verbosity, "high");
  const cached = await catalog.model(id, url, headers("A"), undefined, fetcher);
  assert.equal(cached.service_tiers[0].id, "priority");
  assert.equal(cached.instructions, undefined);
});

test("aborted or failed lookups cannot publish a snapshot or poison another caller", async () => {
  const catalog = new Catalog(identity), pending = deferred(), abort = new AbortController();
  const abandoned = catalog.model(id, url, headers("A"), abort.signal, () => pending.promise);
  abort.abort(); pending.resolve(response("low"));
  await assert.rejects(abandoned, { name: "AbortError" });
  const successful = await catalog.model(id, url, headers("A"), undefined, async () => response("high"));
  assert.equal(successful.default_verbosity, "high");
  await assert.rejects(catalog.model(id, url, headers("B"), undefined, async () => new Response("no", { status: 500 })), /HTTP 500/);
  assert.equal((await catalog.model(id, url, headers("B"), undefined, async () => response("medium"))).default_verbosity, "medium");
});

test("catalog uses the explicit native identity and pinned version in every scope", async () => {
  await new Catalog(identity).model(id, url, headers("A"), undefined, async (target, options) => {
    assert.equal(String(target), "https://chatgpt.com/backend-api/codex/models?client_version=0.153.4");
    assert.equal(options.headers.get("originator"), identity.originator);
    assert.equal(options.headers.get("user-agent"), identity.userAgent);
    assert.equal(options.headers.get("version"), identity.version);
    return response("low");
  });
});

test("native lookup uses the longest prefix, preserves the requested ID and detaches data", () => {
  const entries = [{ slug: "gpt", use_responses_lite: false },
    { slug: "gpt-6", use_responses_lite: true, service_tiers: [{ id: "priority" }] },
    { slug: "gpt-6", use_responses_lite: false }];
  const result = resolveModelMetadata("gpt-6-astra", entries);
  assert.equal(result.slug, "gpt-6-astra");
  assert.equal(result.use_responses_lite, true);
  assert.equal(result.used_fallback_model_metadata, false);
  result.service_tiers[0].id = "changed";
  assert.equal(entries[1].service_tiers[0].id, "priority");
});

test("native namespace matching is narrow and follows direct prefix matching", () => {
  const entries = [{ slug: "gpt-6", use_responses_lite: true }];
  for (const name of ["custom/gpt-6-astra", "openai-codex/gpt-6-astra"]) {
    const result = resolveModelMetadata(name, entries);
    assert.equal(result.slug, name);
    assert.equal(result.used_fallback_model_metadata, false);
  }
  for (const name of ["ns1/ns2/gpt-6", "/gpt-6", "custom.invalid/gpt-6", "different-model"]) {
    assert.equal(resolveModelMetadata(name, entries).used_fallback_model_metadata, true);
  }
  assert.equal(resolveModelMetadata("custom/gpt-6", [...entries, { slug: "custom/", use_responses_lite: false }]).use_responses_lite, false);
});

test("unlisted Astra uses native fallback capabilities without replacing the model", async () => {
  const result = await new Catalog(identity).model(id, url, headers("A"), undefined,
    async () => Response.json({ models: [{ slug: "gpt-5.6-sol", use_responses_lite: true }] }));
  assert.deepEqual(result, {
    slug: id, used_fallback_model_metadata: true,
    default_reasoning_level: null, supported_reasoning_levels: [],
    supports_reasoning_summary_parameter: true, default_reasoning_summary: "auto",
    support_verbosity: false, default_verbosity: null,
    supports_image_detail_original: false,
    service_tiers: [], default_service_tier: null, use_responses_lite: false,
  });
  assert.equal(resolveModelMetadata(id, []).used_fallback_model_metadata, true);
});

test("malformed catalog entries still stop before inference instead of invoking fallback", async () => {
  for (const models of [[{}], [{ slug: 42 }], [null], [{ slug: "" }]]) {
    await assert.rejects(new Catalog(identity).model(id, url, headers("A"), undefined,
      async () => Response.json({ models })), /Invalid Codex model catalog/);
  }
});
