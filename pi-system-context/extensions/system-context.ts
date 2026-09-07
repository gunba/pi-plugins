import { execFile } from "node:child_process";
import type { BeforeAgentStartEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { accessSync, constants, readFileSync, statSync } from "node:fs";
import os from "node:os";
import { delimiter, extname, join } from "node:path";

type ToolProbe = {
  label: string;
  names: string[];
  args?: string[];
  format?: (line: string) => string | undefined;
};

const TOOL_CACHE_MS = 5 * 60_000;
const TOOL_PROBE_TIMEOUT_MS = 350;
const MAX_PROMPT_VALUE_LENGTH = 180;
const MAX_PROMPT_PATH_LENGTH = 240;

let toolCache: { expiresAt: number; summary: Promise<string> } | undefined;

function sanitizePromptValue(value: unknown, fallback = "unknown", maxLength = MAX_PROMPT_VALUE_LENGTH): string {
  const raw = typeof value === "string" ? value : value == null ? "" : String(value);
  const cleaned = raw
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return fallback;
  if (cleaned.length <= maxLength) return cleaned;
  return `${cleaned.slice(0, Math.max(0, maxLength - 1))}…`;
}

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
  const seen = new Set<string>();
  return (process.env[pathKey] ?? "").split(delimiter).flatMap((entry) => {
    if (!entry) return [];
    const key = process.platform === "win32" ? entry.toLowerCase() : entry;
    if (seen.has(key)) return [];
    seen.add(key);
    return [entry];
  });
}

function executableNames(name: string): string[] {
  if (process.platform !== "win32" || extname(name)) return [name];
  const pathExt = (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  return [name, ...pathExt.map((ext) => `${name}${ext.toLowerCase()}`), ...pathExt.map((ext) => `${name}${ext.toUpperCase()}`)];
}

function isExecutableFile(path: string): boolean {
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return false;
    if (process.platform === "win32") return true;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findExecutable(names: string[]): string | undefined {
  for (const name of names) {
    if (/[\\/]/.test(name)) {
      const match = executableNames(name).find(isExecutableFile);
      if (match) return match;
      continue;
    }
    for (const dir of pathEntries()) {
      for (const executable of executableNames(name)) {
        const candidate = join(dir, executable);
        if (isExecutableFile(candidate)) return candidate;
      }
    }
  }
  return undefined;
}

function compactPath(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  const home = os.homedir().replace(/\\/g, "/").replace(/\/+$/, "");
  if (!home || home === "/") return normalized;

  const caseInsensitive = process.platform === "win32";
  const comparableValue = caseInsensitive ? normalized.toLowerCase() : normalized;
  const comparableHome = caseInsensitive ? home.toLowerCase() : home;

  if (comparableValue === comparableHome) return "~";
  return comparableValue.startsWith(`${comparableHome}/`) ? `~${normalized.slice(home.length)}` : normalized;
}

function compactPromptPath(value: string | undefined): string {
  return sanitizePromptValue(value ? compactPath(value) : undefined, "unknown", MAX_PROMPT_PATH_LENGTH);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readSettingsShellPath(settingsPath: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, "utf8")) as unknown;
    if (!isRecord(parsed)) return undefined;
    const shellPath = parsed.shellPath;
    return typeof shellPath === "string" && shellPath.trim() ? shellPath.trim() : undefined;
  } catch {
    return undefined;
  }
}

function configuredShellPath(cwd: string, trusted: boolean): string | undefined {
  return (
    (trusted ? readSettingsShellPath(join(cwd, ".pi", "settings.json")) : undefined) ??
    readSettingsShellPath(join(os.homedir(), ".pi", "agent", "settings.json"))
  );
}

export function versionLine(command: string, args: string[] = ["--version"]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(command, args, {
      encoding: "utf8", timeout: TOOL_PROBE_TIMEOUT_MS, killSignal: "SIGKILL",
      maxBuffer: 16_384, windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error) return resolve(undefined);
      const line = `${stdout}\n${stderr}`.split(/\r?\n/).map((item) => item.trim()).find(Boolean);
      resolve(!line || /not found|not recognized|no such file/i.test(line) ? undefined : line);
    });
  });
}

function formatPythonVersion(line: string): string | undefined {
  const version = line.match(/Python\s+(.+)/i)?.[1];
  return version ? `python ${version}` : undefined;
}

function formatNodeVersion(line: string): string | undefined {
  return line.startsWith("v") ? `node ${line}` : undefined;
}

function formatGitVersion(line: string): string | undefined {
  return line.match(/^git version\s+(.+)/i)?.[1] ? line.replace(/^git version\s+/i, "git ") : undefined;
}

function formatRipgrepVersion(line: string): string | undefined {
  return line.match(/^ripgrep\s+(.+)/i)?.[1] ? line.replace(/^ripgrep\s+/i, "rg ") : undefined;
}

function formatPowerShellVersion(line: string): string | undefined {
  return line ? `ps ${line}` : undefined;
}

function detectedTools(): Promise<string> {
  const now = Date.now();
  if (toolCache && toolCache.expiresAt > now) return toolCache.summary;

  const probes: ToolProbe[] = [
    { label: "python", names: ["python", "py"], format: formatPythonVersion },
    { label: "node", names: ["node"], format: formatNodeVersion },
    { label: "git", names: ["git"], format: formatGitVersion },
    { label: "rg", names: ["rg"], format: formatRipgrepVersion },
    {
      label: "ps",
      names: ["pwsh", "powershell"],
      args: ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"],
      format: formatPowerShellVersion,
    },
  ];

  const summary = Promise.all(probes.map(async (probe) => {
    const executable = findExecutable(probe.names);
    if (!executable) return undefined;
    const line = await versionLine(executable, probe.args);
    if (!line) return undefined;
    return sanitizePromptValue(probe.format?.(line) ?? probe.label, probe.label, 80);
  })).then((results) => results.filter(Boolean).join(", ") || "none detected");
  toolCache = { expiresAt: now + TOOL_CACHE_MS, summary };
  return summary;
}

function eventCwd(event: BeforeAgentStartEvent): string {
  const cwd = event.systemPromptOptions?.cwd;
  return typeof cwd === "string" && cwd.trim() ? cwd : process.cwd();
}

export default function (pi: ExtensionAPI) {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || process.env.TZ;
  const shell = envFirst("SHELL", "ComSpec", "COMSPEC") ?? "unknown";
  const bashPath = findExecutable(["bash"]);
  const terminal = terminalName();
  const platform = `${sanitizePromptValue(os.platform(), "unknown", 40)}/${sanitizePromptValue(os.arch(), "unknown", 40)} ${sanitizePromptValue(os.release(), "unknown", 80)}`;
  pi.on("before_agent_start", async (event, ctx) => {
    const cwd = eventCwd(event);
    const configuredShell = configuredShellPath(cwd, ctx.isProjectTrusted());
    const shellParts = [`shell: ${compactPromptPath(shell)}`];
    if (configuredShell) shellParts.push(`configured shell: ${compactPromptPath(configuredShell)}`);
    if (bashPath) shellParts.push(`bash: ${compactPromptPath(bashPath)}`);

    const context = [
      "### Local env",
      `- timezone: ${sanitizePromptValue(timeZone)}`,
      `- os: ${platform}`,
      `- term: ${sanitizePromptValue(terminal)}; ${shellParts.join("; ")}`,
      `- cwd: ${compactPromptPath(cwd)}`,
      `- path tools: ${sanitizePromptValue(await detectedTools(), "none detected", MAX_PROMPT_VALUE_LENGTH)}`,
    ].join("\n");

    return {
      systemPrompt: `${event.systemPrompt}\n\n${context}`,
    };
  });
}
