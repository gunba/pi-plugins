import assert from "node:assert/strict";
import test from "node:test";
import { codexIdentity, terminalToken, windowsSystem } from "../extensions/identity.ts";
import { identity } from "./fixtures.mjs";

const system = { osType: "Windows", version: "10.0.26100", architecture: "x86_64" };

test("native terminal precedence, presence, version and sanitization fixtures", () => {
  const cases = [
    [{ TERM_PROGRAM: "WezTerm", TERM_PROGRAM_VERSION: "2026.1", WT_SESSION: "yes" }, "WezTerm/2026.1"],
    [{ TERM_PROGRAM: "vscode", WEZTERM_VERSION: "ignored" }, "vscode"],
    [{ TERM_PROGRAM: "  ", WEZTERM_VERSION: "2026.1" }, "WezTerm/2026.1"],
    [{ WEZTERM_VERSION: "", WT_SESSION: "yes" }, "WezTerm"],
    [{ ITERM_PROFILE: "", TERM_SESSION_ID: "yes" }, "iTerm.app"],
    [{ TERM_SESSION_ID: "yes" }, "Apple_Terminal"],
    [{ TERM: "xterm-kitty", WT_SESSION: "yes" }, "kitty"],
    [{ ALACRITTY_SOCKET: "" }, "Alacritty"],
    [{ KONSOLE_VERSION: "42" }, "Konsole/42"],
    [{ GNOME_TERMINAL_SCREEN: "x", VTE_VERSION: "42" }, "gnome-terminal"],
    [{ VTE_VERSION: "42", WT_SESSION: "x" }, "VTE/42"],
    [{ WT_SESSION: "", TERM: "xterm-256color" }, "WindowsTerminal"],
    [{ TERM: "xterm-256color" }, "xterm-256color"],
    [{ TERM_PROGRAM: "a b(🍎)", TERM_PROGRAM_VERSION: "1:2" }, "a_b___/1_2"],
    [{ TERM: "\t " }, "unknown"], [{}, "unknown"],
  ];
  for (const [env, expected] of cases) assert.equal(terminalToken(env), expected, JSON.stringify(env));
});

test("tmux uses the underlying client token, falling back only when unavailable", () => {
  const env = { TERM_PROGRAM: "tmux", TERM_PROGRAM_VERSION: "3", TMUX_PANE: "%1" };
  assert.equal(terminalToken(env, key => key.endsWith("termtype}") ? "ghostty 1.2.3 extra" : "xterm-256color"), "ghostty/1.2.3");
  assert.equal(terminalToken(env, key => key.endsWith("termname}") ? "xterm-256color" : undefined), "xterm-256color");
  assert.equal(terminalToken(env, () => undefined), "tmux/3");
  assert.equal(terminalToken({ TERM_PROGRAM: "tmux" }, () => { throw new Error("must not probe without a tmux marker"); }), "tmux");
});

test("native originator precedence, suffix and exact explicit profile", () => {
  assert.deepEqual(codexIdentity({ system, env: { TERM_PROGRAM: "WezTerm" } }), identity);
  assert.equal(codexIdentity({ system, originator: "provided", env: { CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "override" }, suffix: " host; 1 " }).userAgent,
    "override/0.147.0 (Windows 10.0.26100; x86_64) unknown (host; 1)");
  assert.equal(codexIdentity({ system, env: { CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "bad\nheader" } }).originator, "codex_cli_rs");
  assert.deepEqual(codexIdentity({ env: {}, userAgent: identity.userAgent }), identity);
  assert.throws(() => codexIdentity({ env: {}, userAgent: "codex_cli_rs/0.148.0 anything" }), /0\.147\.0/);
  assert.throws(() => codexIdentity({ env: {}, userAgent: `${identity.userAgent}\r\nInjected: 1` }), /single-line/);
});

test("automatic Windows identity uses native API values", { skip: process.platform !== "win32" }, () => {
  const native = windowsSystem();
  assert.equal(native.osType, "Windows");
  assert.match(native.version, /^\d+\.\d+\.\d+$/);
  assert.match(codexIdentity({ env: { WT_SESSION: "x" } }).userAgent, /\) WindowsTerminal$/);
  assert.equal(codexIdentity({ env: {} }).userAgent,
    `codex_cli_rs/0.147.0 (Windows ${native.version}; ${native.architecture}) unknown`);
});
