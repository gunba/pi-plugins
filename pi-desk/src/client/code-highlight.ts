import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import lua from "highlight.js/lib/languages/lua";
import markdown from "highlight.js/lib/languages/markdown";
import powershell from "highlight.js/lib/languages/powershell";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

for (const [name, language] of Object.entries({ bash, c, cpp, csharp, css, go, ini, java, javascript, json, lua, markdown, powershell, python, rust, sql, typescript, xml, yaml }))
	hljs.registerLanguage(name, language);

const EXTENSIONS: Record<string, string> = {
	ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
	json: "json", jsonc: "json", css: "css", scss: "css", html: "xml", htm: "xml", xml: "xml", svg: "xml", toc: "ini",
	py: "python", sh: "bash", bash: "bash", zsh: "bash", ps1: "powershell", lua: "lua", md: "markdown", yml: "yaml", yaml: "yaml", toml: "ini", ini: "ini",
	rs: "rust", go: "go", java: "java", cs: "csharp", c: "c", h: "c", cpp: "cpp", hpp: "cpp", cc: "cpp", sql: "sql",
};
/** The highlight.js language for a file, from its extension. */
export function languageFor(path: string | undefined): string | undefined {
	const extension = /\.([a-z0-9]+)$/i.exec(path ?? "")?.[1]?.toLowerCase();
	return extension ? EXTENSIONS[extension] : undefined;
}
/** One line of code as highlighted HTML; highlight.js escapes the text. Lines are highlighted independently. */
export function highlightLine(code: string, language: string | undefined): string {
	if (!language || code.length > 2000) return code.replace(/[&<>]/g, character => character === "&" ? "&amp;" : character === "<" ? "&lt;" : "&gt;");
	return hljs.highlight(code, { language, ignoreIllegals: true }).value;
}
