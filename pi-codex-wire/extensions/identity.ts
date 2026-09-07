import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const CODEX_VERSION = "0.147.0";
export interface Identity { originator: string; userAgent: string; version: string }
export interface NativeSystem { osType: string; version: string; architecture: string }
export interface IdentityOptions {
  userAgent?: string;
  originator?: string;
  env?: NodeJS.ProcessEnv;
  system?: NativeSystem;
  suffix?: string;
}

type TmuxQuery = (format: string) => string | undefined;
const nonblank = (value: string | undefined) => value?.trim() ? value : undefined;
const terminalSafe = (value: string) => value.replace(/[^a-zA-Z0-9._/-]/gu, "_");

function queryTmux(format: string): string | undefined {
  try {
    return nonblank(execFileSync("tmux", ["display-message", "-p", format],
      { encoding: "utf8", timeout: 1000, stdio: ["ignore", "pipe", "ignore"] }).trim());
  } catch { return; }
}

/** Port of terminal-detection/src/lib.rs:178-215, 302-402, 422-450, 503-512. */
export function terminalToken(env: NodeJS.ProcessEnv, tmux: TmuxQuery = queryTmux): string {
  const versioned = (name: string, version?: string) => `${name}${nonblank(version) ? `/${version}` : ""}`;
  const program = nonblank(env.TERM_PROGRAM);
  let raw: string;
  if (program) {
    if (program.toLowerCase() === "tmux" && (nonblank(env.TMUX) || nonblank(env.TMUX_PANE))) {
      const type = nonblank(tmux("#{client_termtype}"));
      const name = nonblank(tmux("#{client_termname}"));
      if (type) { const [name, version] = type.trim().split(/\s+/); return terminalSafe(versioned(name, version)); }
      if (name) return terminalSafe(name);
    }
    raw = versioned(program, env.TERM_PROGRAM_VERSION);
  } else if (env.WEZTERM_VERSION !== undefined) raw = versioned("WezTerm", env.WEZTERM_VERSION);
  else if (env.ITERM_SESSION_ID !== undefined || env.ITERM_PROFILE !== undefined || env.ITERM_PROFILE_NAME !== undefined) raw = "iTerm.app";
  else if (env.TERM_SESSION_ID !== undefined) raw = "Apple_Terminal";
  else if (env.KITTY_WINDOW_ID !== undefined || env.TERM?.includes("kitty")) raw = "kitty";
  else if (env.ALACRITTY_SOCKET !== undefined || env.TERM === "alacritty") raw = "Alacritty";
  else if (env.KONSOLE_VERSION !== undefined) raw = versioned("Konsole", env.KONSOLE_VERSION);
  else if (env.GNOME_TERMINAL_SCREEN !== undefined) raw = "gnome-terminal";
  else if (env.VTE_VERSION !== undefined) raw = versioned("VTE", env.VTE_VERSION);
  else if (env.WT_SESSION !== undefined) raw = "WindowsTerminal";
  else raw = nonblank(env.TERM) ?? "unknown";
  return terminalSafe(raw);
}

let nativeSystem: NativeSystem | undefined;
export function windowsSystem(): NativeSystem {
  if (nativeSystem) return nativeSystem;
  if (process.platform !== "win32") throw new Error("Set --codex-wire-user-agent to a verified native User-Agent on this platform");
  // GetNativeSystemInfo, rather than process architecture, also handles WOW64/emulation.
  const script = fileURLToPath(new URL("./native-os-info.ps1", import.meta.url));
  const output = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", script],
    { encoding: "utf8", timeout: 10_000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
  const result = JSON.parse(output.replace(/^\uFEFF/, "")) as NativeSystem;
  if (result.osType !== "Windows" || !/^(unknown|\d+\.\d+\.\d+)$/.test(result.version) ||
    !["x86_64", "ia64", "arm", "aarch64", "i386", "unknown"].includes(result.architecture)) {
    throw new Error("Cannot establish native Windows identity; use --codex-wire-user-agent");
  }
  nativeSystem = Object.freeze(result);
  return nativeSystem;
}

/** Pinned default_client.rs:40-79, 159-212. Full explicit profiles never use OS guesses. */
export function codexIdentity(options: IdentityOptions = {}): Identity {
  const env = options.env ?? process.env;
  const requested = env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE ?? options.originator ?? "codex_cli_rs";
  const originator = /^[\t\x20-\x7e]*$/.test(requested) ? requested : "codex_cli_rs";
  if (options.userAgent !== undefined) {
    if (!options.userAgent.startsWith(`${originator}/${CODEX_VERSION} `) || !/^[\x20-\x7e]+$/.test(options.userAgent)) {
      throw new Error(`codex-wire-user-agent must be a single-line ${originator}/${CODEX_VERSION} profile`);
    }
    return { originator, version: CODEX_VERSION, userAgent: options.userAgent };
  }
  const system = options.system ?? windowsSystem();
  const suffix = options.suffix?.trim();
  const userAgent = `${originator}/${CODEX_VERSION} (${system.osType} ${system.version}; ${system.architecture}) ${terminalToken(env)}${suffix ? ` (${suffix})` : ""}`;
  return { originator, version: CODEX_VERSION, userAgent: userAgent.replace(/[^\t\x20-\x7e]/gu, "_") };
}
