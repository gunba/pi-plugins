import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fetchPages } from "../extensions/web-search.ts";

const ctx = { sessionManager: { getSessionId: () => "session" }, model: { id: "model" } };
const PAGE = `<html><head><title>SECTION 110-45</title><script>track()</script></head><body><nav>Menu</nav>
<main><h2>Section 110-45</h2><p>Assets acquired after 7.30&nbsp;pm on 13 May 1997</p><ul><li>Cost &amp; base</li><li>Reduced cost base</li></ul></main>
<footer>Copyright</footer></body></html>`;

test("pages the service cannot read, and local network addresses, are read from this computer", async (t) => {
	// No Exa key: the free service, stubbed here, reads pages.
	const agentDir = mkdtempSync(join(tmpdir(), "web-fetch-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	t.after(() => {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(agentDir, { recursive: true, force: true });
	});
	const asked = [];
	const mcp = { call: async (_name, args) => {
		asked.push(...args.urls);
		return JSON.stringify({ results: [], errors: args.urls.map(url => ({ url, error: "CRAWL_UNKNOWN_ERROR", http_status_code: 500 })) });
	} };
	t.mock.method(globalThis, "fetch", async (url) => String(url).includes("blocked")
		? new Response("<title>Just a moment...</title>", { status: 403, headers: { "content-type": "text/html" } })
		: new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } }));

	const result = await fetchPages({ urls: ["https://www.ato.gov.au/law/110-45", "http://192.168.1.5/status", "https://blocked.example/page"] }, undefined, ctx, mcp);
	assert.deepEqual(asked, ["https://www.ato.gov.au/law/110-45", "https://blocked.example/page"]);
	const text = "## Section 110-45\n\nAssets acquired after 7.30 pm on 13 May 1997\n\n- Cost & base\n- Reduced cost base";
	assert.equal(result.content[0].text, [
		`## SECTION 110-45\nhttp://192.168.1.5/status · read from this computer\n${text}`,
		`## SECTION 110-45\nhttps://www.ato.gov.au/law/110-45 · read from this computer\n${text}`,
		"Could not read https://blocked.example/page: CRAWL_UNKNOWN_ERROR (HTTP 500); from this computer, the site requires a browser to pass its bot check (HTTP 403)",
	].join("\n\n"));
	assert.equal(result.details.errors, 1);
});
