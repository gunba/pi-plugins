import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const CODEX_VERSION = "0.153.4";
// Electron package.json version, not the Windows Store package version.
export const DESKTOP_APP_VERSION = "26.903.61454";
export type Client = "cli" | "desktop";
export interface Identity { originator: string; userAgent: string; version: string }
export interface NativeSystem { osType: string; version: string; architecture: string }
export interface IdentityOptions {
  client?: Client;
  desktopVersion?: string;
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
  if (process.platform !== "win32") throw new Error("Windows identity is available only on Windows");
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

// Names and display forms from the pinned os_info 3.14.0 Linux release parsers.
const linuxTypes: Record<string, string> = {
  almalinux: "AlmaLinux", alpaquita: "Alpaquita Linux", alpine: "Alpine Linux",
  altlinux: "ALT Linux", amzn: "Amazon Linux AMI", aosc: "AOSC OS",
  arch: "Arch", archarm: "Arch", artix: "Artix Linux", bluefin: "Bluefin",
  cachyos: "CachyOS Linux", centos: "CentOS", debian: "Debian",
  elementary: "Elementary OS", fedora: "Fedora", instantos: "instantOS",
  kali: "Kali Linux", linuxmint: "Linux Mint", mariner: "Mariner",
  "manjaro-arm": "Manjaro", nixos: "NixOS", nobara: "Nobara Linux",
  Uos: "UOS", opencloudos: "OpenCloudOS", openEuler: "EulerOS",
  ol: "Oracle Linux", opensuse: "openSUSE", "opensuse-leap": "openSUSE",
  "opensuse-microos": "openSUSE", "opensuse-tumbleweed": "openSUSE",
  pika: "PikaOS", rhel: "Red Hat Enterprise Linux", rocky: "Rocky Linux",
  sled: "SUSE Linux Enterprise Server", sles: "SUSE Linux Enterprise Server",
  sles_sap: "SUSE Linux Enterprise Server", ubuntu: "Ubuntu",
  ultramarine: "Ultramarine Linux", void: "Void Linux", zorin: "Zorin OS",
  Alpaquita: "Alpaquita Linux", ALT: "ALT Linux", Amazon: "Amazon Linux AMI",
  AmazonAMI: "Amazon Linux AMI", AOSC: "AOSC OS", Arch: "Arch",
  Artix: "Artix Linux", Bluefin: "Bluefin", CentOS: "CentOS",
  Debian: "Debian", Elementary: "Elementary OS", EndeavourOS: "EndeavourOS",
  Fedora: "Fedora", "Fedora Linux": "Fedora", Garuda: "Garuda Linux",
  Gentoo: "Gentoo Linux", Kali: "Kali Linux", Linuxmint: "Linux Mint",
  MaboxLinux: "Mabox", ManjaroLinux: "Manjaro", "Manjaro-ARM": "Manjaro",
  Mariner: "Mariner", NixOS: "NixOS", NobaraLinux: "Nobara Linux",
  OpenCloudOS: "OpenCloudOS", openSUSE: "openSUSE", OracleServer: "Oracle Linux",
  Pika: "PikaOS", Pop: "Pop!_OS", Raspbian: "Raspberry Pi OS",
  RedHatEnterprise: "Red Hat Enterprise Linux",
  RedHatEnterpriseServer: "Red Hat Enterprise Linux", Solus: "Solus",
  SUSE: "SUSE Linux Enterprise Server", Ubuntu: "Ubuntu",
  UltramarineLinux: "Ultramarine Linux", VoidLinux: "Void Linux",
  Zorin: "Zorin OS",
};

function linuxVersion(value: string | undefined, lsb = false): string {
  if (!value) return "Unknown";
  if (lsb && value === "rolling") return "Rolling Release";
  const numeric = value.trim().match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?\.?$/);
  return numeric ? `${BigInt(numeric[1])}.${BigInt(numeric[2] ?? "0")}.${BigInt(numeric[3] ?? "0")}` : value;
}

export function linuxRelease(lsb: string | undefined, osRelease: string | undefined): Pick<NativeSystem, "osType" | "version"> {
  const field = (text: string | undefined, key: string) =>
    text?.split("\n").find(line => line.startsWith(key))?.slice(key.length).trim().replace(/^"|"$/g, "");
  const lsbWord = (key: string) => field(lsb, key)?.split(/\s+/)[0];
  const distributor = lsbWord("Distributor ID:");
  const lsbType = distributor && Object.hasOwn(linuxTypes, distributor) ? linuxTypes[distributor] : undefined;
  if (lsbType) {
    const release = lsbWord("Release:");
    return { osType: lsbType, version: linuxVersion(release?.startsWith(".") || release?.endsWith(".") ? undefined : release, true) };
  }
  const id = field(osRelease, "ID=");
  const osType = id && Object.hasOwn(linuxTypes, id) ? linuxTypes[id] : undefined;
  return { osType: osType ?? "Linux", version: osType ? linuxVersion(field(osRelease, "VERSION_ID=")) : "Unknown" };
}

export function linuxSystem(): NativeSystem {
  if (process.platform !== "linux") throw new Error("Linux identity is available only on Linux");
  const command = (name: string, args: string[]) => {
    try { return execFileSync(name, args, { encoding: "utf8", timeout: 1000, stdio: ["ignore", "pipe", "ignore"] }).trim(); }
    catch { return undefined; }
  };
  let osRelease: string | undefined;
  try { osRelease = readFileSync("/etc/os-release", "utf8"); } catch { /* Native falls back to Linux. */ }
  const release = linuxRelease(command("lsb_release", ["-a"]), osRelease);
  return { ...release, architecture: command("uname", ["-m"]) || "unknown" };
}

/** Pinned default_client.rs:40-79, 159-212. Full explicit profiles never use OS guesses. */
export function codexIdentity(options: IdentityOptions = {}): Identity {
  const env = options.env ?? process.env;
  const desktop = options.client === "desktop";
  const desktopVersion = options.desktopVersion ?? DESKTOP_APP_VERSION;
  if (desktop && !/^\d+\.\d+\.\d+(?:\.\d+)?(?:-[a-zA-Z0-9.-]+)?$/.test(desktopVersion)) {
    throw new Error("codex-wire-desktop-version must be an application version");
  }
  const requested = env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE ?? options.originator ?? (desktop ? "Codex Desktop" : "codex_cli_rs");
  if (desktop && requested !== "Codex Desktop") throw new Error("Desktop identity requires originator Codex Desktop; remove the conflicting override");
  const originator = /^[\t\x20-\x7e]*$/.test(requested) ? requested : "codex_cli_rs";
  const suffix = desktop ? `Codex Desktop; ${desktopVersion}` : options.suffix?.trim();
  if (options.userAgent !== undefined) {
    if (!options.userAgent.startsWith(`${originator}/${CODEX_VERSION} `) || !/^[\x20-\x7e]+$/.test(options.userAgent)) {
      throw new Error(`codex-wire-user-agent must be a single-line ${originator}/${CODEX_VERSION} profile`);
    }
    if (desktop && !options.userAgent.endsWith(` (${suffix})`)) throw new Error("Desktop User-Agent must include the selected Desktop application version suffix");
    return { originator, version: CODEX_VERSION, userAgent: options.userAgent };
  }
  const system = options.system ?? (process.platform === "linux" ? linuxSystem() : windowsSystem());
  const userAgent = `${originator}/${CODEX_VERSION} (${system.osType} ${system.version}; ${system.architecture}) ${terminalToken(env)}${suffix ? ` (${suffix})` : ""}`;
  return { originator, version: CODEX_VERSION, userAgent: userAgent.replace(/[^\t\x20-\x7e]/gu, "_") };
}
