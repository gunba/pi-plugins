import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import { delimiter, extname, join } from "node:path";

type ToolProbe = {
  label: string;
  names: string[];
  args?: string[];
  format?: (line: string) => string | undefined;
};

const TOOL_CACHE_MS = 5 * 60_000;
let toolCache: { expiresAt: number; summary: string } | undefined;

function envFirst(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (value && value.trim()) return value;
  }
  return undefined;
}

function terminalName(): string {
  if (process.env.WT_SESSION) return "Windows Terminal";
  return envFirst("TERM_PROGRAM", "TERMINAL_EMULATOR", "TERM") ?? "unknown";
}

function pathEntries(): string[] {
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  return (process.env[pathKey] ?? "").split(delimiter).filter(Boolean);
}

function executableNames(name: string): string[] {
  if (process.platform !== "win32" || extname(name)) return [name];
  const pathExt = (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter(Boolean);
  return [name, ...pathExt.map((ext) => `${name}${ext.toLowerCase()}`), ...pathExt.map((ext) => `${name}${ext.toUpperCase()}`)];
}

function findExecutable(names: string[]): string | undefined {
  for (const name of names) {
    if (/[\\/]/.test(name) && existsSync(name)) return name;
    for (const dir of pathEntries()) {
      for (const executable of executableNames(name)) {
        const candidate = join(dir, executable);
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  return undefined;
}

function compactPath(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  const home = os.homedir().replace(/\\/g, "/");
  return normalized.toLowerCase().startsWith(home.toLowerCase()) ? `~${normalized.slice(home.length)}` : normalized;
}

function formatLocalTime(timeZone: string | undefined): string {
  const options: Intl.DateTimeFormatOptions = {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  };
  if (timeZone) options.timeZone = timeZone;
  return new Intl.DateTimeFormat("en-AU", options).format(new Date());
}

function readSettingsShellPath(settingsPath: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, "utf8")) as { shellPath?: unknown };
    return typeof parsed.shellPath === "string" && parsed.shellPath.trim() ? parsed.shellPath.trim() : undefined;
  } catch {
    return undefined;
  }
}

function configuredBashPath(cwd: string): string | undefined {
  return (
    readSettingsShellPath(join(cwd, ".pi", "settings.json")) ??
    readSettingsShellPath(join(os.homedir(), ".pi", "agent", "settings.json")) ??
    findExecutable(["bash"])
  );
}

function versionLine(command: string, args: string[] = ["--version"]): string | undefined {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: 900,
    windowsHide: true,
  });
  const line = `${result.stdout ?? ""}\n${result.stderr ?? ""}`
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find(Boolean);
  if (!line || /not found|not recognized|no such file/i.test(line)) return undefined;
  return line;
}

function detectedTools(): string {
  const now = Date.now();
  if (toolCache && toolCache.expiresAt > now) return toolCache.summary;

  const probes: ToolProbe[] = [
    {
      label: "python",
      names: ["python", "py"],
      format: (line) => {
        const version = line.match(/Python\s+(.+)/i)?.[1];
        return version ? `python ${version}` : undefined;
      },
    },
    { label: "node", names: ["node"], format: (line) => (line.startsWith("v") ? `node ${line}` : undefined) },
    { label: "git", names: ["git"], format: (line) => line.match(/^git version\s+(.+)/i)?.[1] ? line.replace(/^git version\s+/i, "git ") : undefined },
    { label: "rg", names: ["rg"], format: (line) => line.match(/^ripgrep\s+(.+)/i)?.[1] ? line.replace(/^ripgrep\s+/i, "rg ") : undefined },
    { label: "ps", names: ["pwsh", "powershell"], args: ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"], format: (line) => line ? `ps ${line}` : undefined },
  ];

  const tools = probes.flatMap((probe) => {
    const executable = findExecutable(probe.names);
    if (!executable) return [];
    const formatted = probe.format?.(versionLine(executable, probe.args) ?? "");
    return [formatted ?? probe.label];
  });

  const summary = tools.length ? tools.join(", ") : "none detected";
  toolCache = { expiresAt: now + TOOL_CACHE_MS, summary };
  return summary;
}

export default function (pi: any) {
  pi.on("before_agent_start", async (event: any) => {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || process.env.TZ;
    const shell = envFirst("SHELL", "ComSpec", "COMSPEC") ?? "unknown";
    const cwd = event.systemPromptOptions?.cwd ?? process.cwd();
    const bashPath = configuredBashPath(cwd);

    const context = [
      "### Local env",
      `- time: ${formatLocalTime(timeZone)} (${timeZone ?? "unknown TZ"})`,
      `- os: ${os.type()} ${os.release()} (${os.platform()}/${os.arch()})`,
      `- term: ${terminalName()}`,
      `- shell: ${compactPath(shell)}${bashPath ? `; bash: ${compactPath(bashPath)}` : ""}`,
      `- cwd: ${compactPath(cwd)}`,
      `- path tools: ${detectedTools()}`,
    ].join("\n");

    return {
      systemPrompt: `${event.systemPrompt}\n\n${context}`,
    };
  });
}
