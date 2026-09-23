import assert from "node:assert/strict";
import test from "node:test";
import { codexIdentity, linuxRelease, linuxSystem, terminalToken, windowsSystem } from "../extensions/identity.ts";
import { identity } from "./fixtures.mjs";

const system = { osType: "Windows", version: "10.0.26100", architecture: "x86_64" };

test("Desktop app-server identity uses Desktop originator and initialized client suffix", () => {
  const options = { client: "desktop", system, env: {} };
  const desktop = codexIdentity(options);
  assert.equal(desktop.originator, "Codex Desktop");
  assert.equal(desktop.version, "0.155.0");
  assert.equal(desktop.userAgent, "Codex Desktop/0.155.0 (Windows 10.0.26100; x86_64) unknown (Codex Desktop; 26.903.61454)");
  assert.deepEqual(codexIdentity({ ...options, userAgent: desktop.userAgent }), desktop);
  assert.match(codexIdentity({ ...options, desktopVersion: "26.904.12345" }).userAgent, /26\.904\.12345\)$/);
  assert.throws(() => codexIdentity({ ...options, desktopVersion: "bad\nheader" }), /application version/);
  assert.throws(() => codexIdentity({ ...options, userAgent: identity.userAgent }), /single-line/);
  assert.throws(() => codexIdentity({ ...options, userAgent: desktop.userAgent.replace(/ \([^()]+\)$/, "") }), /suffix/);
  assert.throws(() => codexIdentity({ ...options, env: { CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "codex_cli_rs" } }), /conflicting override/);
});

test("native terminal precedence, presence, version and sanitization fixtures", () => {
  const cases = [
    [{ TERM_PROGRAM: "WezTerm", TERM_PROGRAM_VERSION: "2026.1", WT_SESSION: "yes" }, "WezTerm/2026.1"],
    [{ TERM_PROGRAM: "vscode", WEZTERM_VERSION: "ignored" }, "vscode"],
    [{ TERM_PROGRAM: "  ", WEZTERM_VERSION: "2026.1" }, "WezTerm/2026.1"],
    [{ GHOSTTY_RESOURCES_DIR: "/opt/ghostty", WEZTERM_VERSION: "ignored" }, "ghostty"],
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

test("tmux detection uses environment hints without executing terminal helpers", () => {
  const env = { TERM_PROGRAM: "tmux", TERM_PROGRAM_VERSION: "3", TMUX_PANE: "%1" };
  assert.equal(terminalToken({ ...env, GHOSTTY_RESOURCES_DIR: "/opt/ghostty" }), "ghostty");
  assert.equal(terminalToken({ ...env, WEZTERM_VERSION: "2026.1" }), "WezTerm/2026.1");
  assert.equal(terminalToken({ ...env, TERM: "screen-256color" }), "screen-256color");
  assert.equal(terminalToken(env), "unknown");
});

test("native originator precedence, suffix and exact explicit profile", () => {
  assert.deepEqual(codexIdentity({ system, env: { TERM_PROGRAM: "WezTerm" } }), identity);
  assert.equal(codexIdentity({ system, originator: "provided", env: { CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "override" }, suffix: " host; 1 " }).userAgent,
    "override/0.155.0 (Windows 10.0.26100; x86_64) unknown (host; 1)");
  assert.equal(codexIdentity({ system, env: { CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "bad\nheader" } }).originator, "codex_cli_rs");
  assert.deepEqual(codexIdentity({ env: {}, userAgent: identity.userAgent }), identity);
  assert.throws(() => codexIdentity({ env: {}, userAgent: "codex_cli_rs/0.153.4 anything" }), /0\.155\.0/);
  assert.throws(() => codexIdentity({ env: {}, userAgent: `${identity.userAgent}\r\nInjected: 1` }), /single-line/);
});

test("Linux release detection matches pinned native version and distro formatting", () => {
  assert.deepEqual(linuxRelease("Distributor ID:\tFedora Linux\nRelease:\t43 Workstation\n", "ID=ubuntu\nVERSION_ID=\"24.04\"\n"),
    { osType: "Fedora", version: "43.0.0" });
  assert.deepEqual(linuxRelease(undefined, 'NAME="Ubuntu"\nID=ubuntu\nVERSION_ID="24.04"\n'),
    { osType: "Ubuntu", version: "24.4.0" });
  assert.deepEqual(linuxRelease("Distributor ID:\tunknown\n", "ID=cachyos\n"),
    { osType: "CachyOS Linux", version: "Unknown" });
  assert.deepEqual(linuxRelease("Distributor ID:\tArch\nRelease:\trolling\n", undefined),
    { osType: "Arch", version: "Rolling Release" });
  assert.deepEqual(linuxRelease(undefined, "ID=unrecognized\nVERSION_ID=42\n"),
    { osType: "Linux", version: "Unknown" });
});

test("automatic Linux Desktop identity uses native system fields without a saved profile", { skip: process.platform !== "linux" }, () => {
  const native = linuxSystem();
  assert.match(native.architecture, /^[a-zA-Z0-9_]+$/);
  assert.equal(codexIdentity({ client: "desktop", env: { TERM_PROGRAM: "ghostty", TERM_PROGRAM_VERSION: "1.2.3" } }).userAgent,
    `Codex Desktop/0.155.0 (${native.osType} ${native.version}; ${native.architecture}) ghostty/1.2.3 (Codex Desktop; 26.903.61454)`);
  assert.equal(codexIdentity({ env: { TERM_PROGRAM: "ghostty" } }).userAgent,
    `codex_cli_rs/0.155.0 (${native.osType} ${native.version}; ${native.architecture}) ghostty`);
});

test("automatic Windows identity uses native API values", { skip: process.platform !== "win32" }, () => {
  const native = windowsSystem();
  assert.equal(native.osType, "Windows");
  assert.match(native.version, /^\d+\.\d+\.\d+$/);
  assert.match(codexIdentity({ env: { WT_SESSION: "x" } }).userAgent, /\) WindowsTerminal$/);
  assert.equal(codexIdentity({ env: {} }).userAgent,
    `codex_cli_rs/0.155.0 (Windows ${native.version}; ${native.architecture}) unknown`);
});
