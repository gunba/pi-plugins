import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getCapabilities, setCapabilities, Markdown } from "@earendil-works/pi-tui";
import { fileLink, rewriteFileLinks } from "../extensions/links.ts";
import localLinks from "../extensions/local-links.ts";

for (const [target, cwd, expected] of [
	["AppData/Local/Temp/pi-clipboard.png", "C:/Users/Test", "file:///C:/Users/Test/AppData/Local/Temp/pi-clipboard.png"],
	[String.raw`AppData\Local\Temp\pi-clipboard.png`, "C:/Users/Test", "file:///C:/Users/Test/AppData/Local/Temp/pi-clipboard.png"],
	["../out/a%20b.pdf", "C:/workspace/project", "file:///C:/workspace/out/a%20b.pdf"],
	["./reports/", "C:/workspace", "file:///C:/workspace/reports/"],
	["D:/elsewhere/a.pdf", "C:/workspace", "file:///D:/elsewhere/a.pdf"],
	[String.raw`C:\Users\TEST~1\AppData\Local\Temp\a.png`, "C:/workspace", "file:///C:/Users/TEST~1/AppData/Local/Temp/a.png"],
	[String.raw`\\server\share\a b.pdf`, "C:/workspace", "file://server/share/a%20b.pdf"],
	["~/a.pdf", "C:/workspace", "file:///C:/Users/Test/a.pdf"],
	["../a.pdf", "/home/test/work", "file:///home/test/a.pdf"],
	["/tmp/中文.pdf", "/work", "file:///tmp/%E4%B8%AD%E6%96%87.pdf"],
	["a%23b.pdf", "/work", "file:///work/a%23b.pdf"],
	["100%.pdf", "/work", "file:///work/100%25.pdf"],
	["a%2520b.pdf", "/work", "file:///work/a%2520b.pdf"],
	["report.md?raw=1&x=2#section", "/work", "file:///work/report.md?raw=1&x=2#section"],
]) {
	test(`resolve ${target} against ${cwd}`, () => {
		assert.equal(fileLink(target, cwd, "C:/Users/Test")?.replaceAll("%7E", "~"), expected);
	});
}

for (const target of [
	"https://example.com/a.pdf", "http://localhost/x", "//example.com/a", "www.example.com/a",
	"mailto:test@example.com", "vscode://file/C:/x", "obsidian://open", "legal://act/x",
	"file:///C:/already%20correct.pdf", "#heading", "?query", "D:relative.txt",
	"", "bad%FF.pdf", "bad%00.pdf", "bad%2Fpath.pdf", "bad%5Cpath.pdf",
	String.raw`\\?\C:\device`, "a\u001b.pdf",
]) {
	test(`leave non-file or unsafe destination ${JSON.stringify(target)}`, () => {
		assert.equal(fileLink(target, "C:/workspace"), undefined);
	});
}

test("replace destinations only, including nested labels, titles and balanced filenames", () => {
	const input = '[**Report** and `[code]`](<out/my report (final).pdf> "Keep title") and [nested [label]](out/a(b).pdf)';
	assert.equal(rewriteFileLinks(input, "/work"),
		'[**Report** and `[code]`](<file:///work/out/my%20report%20%28final%29.pdf> "Keep title") and [nested [label]](file:///work/out/a%28b%29.pdf)');
});

test("reference links, collapsed references and shortcuts retain formatting", () => {
	const input = "[first][REPORT]\n\n[report][] and [report]\n\n[report]: <out/my report.pdf>\n  'Title'\n\n[unused]: no-change.pdf";
	assert.equal(rewriteFileLinks(input, "/work"),
		"[first][REPORT]\n\n[report][] and [report]\n\n[report]: <file:///work/out/my%20report.pdf>\n  'Title'\n\n[unused]: no-change.pdf");
});

test("code, escaped links, HTML, inline images, image-only definitions and incomplete streaming are unchanged", () => {
	const input = [
		"`[code](x.pdf)`", "```md\n[code](x.pdf)\n```", "    [code](x.pdf)",
		String.raw`\[escaped](x.pdf)`, '<a href="x.pdf">HTML</a>', "![image](x.png)",
		"![image][img]\n\n[img]: x.png", "[partial](out/x",
	].join("\n\n");
	assert.equal(rewriteFileLinks(input, "/work"), input);
});

test("blockquote and list continuation destinations preserve container markers", () => {
	const input = "> [quoted](\n> out/a.pdf)\n\n- [listed](\n  out/b.pdf)\n\n> [id]:\n>   out/c.pdf\n>\n> [reference][id]";
	assert.equal(rewriteFileLinks(input, "/work"),
		"> [quoted](\n> file:///work/out/a.pdf)\n\n- [listed](\n  file:///work/out/b.pdf)\n\n> [id]:\n>   file:///work/out/c.pdf\n>\n> [reference][id]");
});

test("non-ASCII filename whitespace and literal trailing backslashes are preserved", () => {
	assert.equal(rewriteFileLinks("[x](\u00a0name.pdf)", "/work"), "[x](file:///work/%C2%A0name.pdf)");
	assert.equal(rewriteFileLinks('[x](folder\\ "title")', "/work"), '[x](file:///work/folder%5C "title")');
});

test("empty labels, escaped destinations, CRLF and reference labels work", () => {
	const input = '[](a\\(b\\).pdf)\r\n\r\n[x][a\\]b]\r\n\r\n[a\\]b]: other.pdf';
	assert.equal(rewriteFileLinks(input, "/work"),
		'[](file:///work/a%28b%29.pdf)\r\n\r\n[x][a\\]b]\r\n\r\n[a\\]b]: file:///work/other.pdf');
});

test("table delimiters in escaped filenames cannot split the generated destination", () => {
	assert.equal(rewriteFileLinks("| File |\n| --- |\n| [x](a\\|b.pdf) |", "/work"),
		"| File |\n| --- |\n| [x](file:///work/a%7Cb.pdf) |");
});

function extension(cwd) {
	const hooks = new Map();
	let transform;
	localLinks({
		on: (name, callback) => hooks.set(name, callback),
		registerMarkdownTransformer: callback => { transform = callback; },
	});
	hooks.get("session_start")({}, { cwd });
	return { hooks, transform: (text, messageType = "assistant", isStreaming = false) =>
		transform(text, { messageType, isStreaming, availableWidth: 80 }) };
}

test("display hook handles streaming/restoration without modifying messages or mixing session directories", () => {
	const first = extension("C:/one");
	const second = extension("D:/two");
	const message = Object.freeze({ role: "assistant", content: "[x](out.pdf)" });
	const original = JSON.stringify(message);
	assert.equal(first.transform(message.content, "assistant", true), "[x](file:///C:/one/out.pdf)");
	assert.equal(first.transform(message.content), "[x](file:///C:/one/out.pdf)");
	assert.equal(second.transform(message.content), "[x](file:///D:/two/out.pdf)");
	assert.equal(first.transform(message.content, "user"), message.content);
	assert.equal(first.transform(message.content, "assistant-thinking"), "[x](file:///C:/one/out.pdf)");
	first.hooks.get("session_start")({}, { cwd: "E:/resumed" });
	assert.equal(first.transform(message.content), "[x](file:///E:/resumed/out.pdf)");
	first.hooks.get("before_agent_start")({}, { cwd: "F:/updated" });
	assert.equal(first.transform(message.content), "[x](file:///F:/updated/out.pdf)");
	assert.equal(JSON.stringify(message), original);
	assert.deepEqual([...first.hooks.keys()].sort(), ["before_agent_start", "session_shutdown", "session_start"]);
});

test("Pi's renderer emits absolute OSC-8 targets, including entity-sensitive filenames", t => {
	const capabilities = getCapabilities();
	setCapabilities({ ...capabilities, hyperlinks: true });
	t.after(() => setCapabilities(capabilities));
	const theme = Object.fromEntries([
		"heading", "link", "linkUrl", "code", "codeBlock", "codeBlockBorder", "quote",
		"quoteBorder", "hr", "listBullet", "bold", "italic", "strikethrough", "underline",
	].map(key => [key, text => text]));
	const { transform } = extension("C:/workspace");
	const input = "[Open](out/a%20b.pdf) [entity](out/%26copy;.pdf) [web](https://example.com)";
	const markdown = new Markdown(input, 0, 0, theme, undefined, { transform: text => transform(text) });
	const rendered = markdown.render(120).join("\n");
	assert.ok(rendered.includes("\x1b]8;;file:///C:/workspace/out/a%20b.pdf\x1b\\Open"), JSON.stringify(rendered));
	assert.ok(rendered.includes("\x1b]8;;file:///C:/workspace/out/%26copy;.pdf\x1b\\entity"), JSON.stringify(rendered));
	assert.ok(rendered.includes("\x1b]8;;https://example.com\x1b\\web"), JSON.stringify(rendered));
	assert.ok(markdown.render(12).join("\n").includes("\x1b]8;;file:///C:/workspace/out/a%20b.pdf\x1b\\"));
	assert.equal(transform(transform(input)), transform(input));
});

test("large messages and cache eviction still resolve every complete link", () => {
	const { transform } = extension("C:/work");
	const large = "padding ".repeat(9_000) + "[last](last.pdf)";
	assert.ok(transform(large).endsWith("[last](file:///C:/work/last.pdf)"));
	for (let i = 0; i < 600; i++) assert.equal(transform(`[${i}](${i}.pdf)`), `[${i}](file:///C:/work/${i}.pdf)`);
	assert.equal(transform("[0](0.pdf)"), "[0](file:///C:/work/0.pdf)");
	const many = Array.from({ length: 500 }, (_, i) => `[${i}](${i}.pdf)`).join("\n");
	assert.equal((transform(many).match(/file:\/\/\/C:\/work\//g) ?? []).length, 500);
});

test("a resolved URL reads the exact local artifact without changing the saved transcript", t => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-local-links-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	mkdirSync(join(cwd, "out"));
	writeFileSync(join(cwd, "out", "my report.md"), "local artifact", "utf8");
	const text = "[Open](out/my%20report.md)";
	const saved = join(cwd, "session.jsonl");
	writeFileSync(saved, JSON.stringify({ role: "assistant", content: text }) + "\n");
	const before = readFileSync(saved);
	const { transform } = extension(cwd);
	const href = transform(text).match(/\]\(([^)]+)\)/)[1];
	assert.equal(readFileSync(new URL(href), "utf8"), "local artifact");
	assert.deepEqual(readFileSync(saved), before);
});
