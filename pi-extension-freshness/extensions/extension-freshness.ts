import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  DefaultPackageManager,
  SettingsManager,
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
  type ResolvedResource,
  type SourceInfo,
  type Theme,
  type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";

const CUSTOM_TYPE = "pi-extension-freshness";
const FRESH_DAYS = 90;
const STALE_DAYS = 365;
const MAX_COLLAPSED_ROWS = 18;

type FreshnessStatus = "fresh" | "aging" | "stale" | "unknown";
type FreshnessSource = "git" | "file" | "unknown";

type ExtensionResource = {
  path: string;
  source: string;
  scope: string;
  origin: string;
  baseDir?: string;
};

type ExtensionFreshnessRow = ExtensionResource & {
  label: string;
  sourceLabel: string;
  updatedAt?: string;
  updatedDate: string;
  ageDays?: number;
  age: string;
  status: FreshnessStatus;
  freshnessSource: FreshnessSource;
};

type ExtensionFreshnessReport = {
  generatedAt: string;
  rows: ExtensionFreshnessRow[];
  counts: Record<FreshnessStatus, number>;
};

type UpdateInfo = {
  date?: Date;
  source: FreshnessSource;
};

function padTo(value: string, width: number): string {
  return truncateToWidth(value, width, "", true);
}

function padStartVisible(value: string, width: number): string {
  const padding = width - visibleWidth(value);
  return padding > 0 ? `${" ".repeat(padding)}${value}` : value;
}

function truncatePlain(value: string, width: number): string {
  return truncateToWidth(value, Math.max(1, width), "…");
}

function toPosix(value: string): string {
  return value.split(sep).join("/");
}

function safeStat(path: string): ReturnType<typeof statSync> | undefined {
  try {
    return statSync(path);
  } catch {
    return undefined;
  }
}

function pathExists(path: string | undefined): path is string {
  return typeof path === "string" && path.length > 0 && existsSync(path);
}

function canonicalKey(path: string): string {
  return path.startsWith("<") ? path : resolve(path);
}

function isRealPath(path: string): boolean {
  return path.length > 0 && !path.startsWith("<") && pathExists(path);
}

function formatDate(date: Date | undefined): string {
  return date ? date.toISOString().slice(0, 10) : "unknown";
}

function daysSince(date: Date | undefined, now: Date): number | undefined {
  if (!date) return undefined;
  return Math.max(0, Math.floor((now.getTime() - date.getTime()) / 86_400_000));
}

function formatAge(days: number | undefined): string {
  if (days === undefined) return "?";
  if (days === 0) return "today";
  if (days < 365) return `${days}d`;
  const years = days / 365;
  return `${years >= 10 ? Math.round(years).toString() : years.toFixed(1)}y`;
}

function statusForAge(days: number | undefined): FreshnessStatus {
  if (days === undefined) return "unknown";
  if (days >= STALE_DAYS) return "stale";
  if (days >= FRESH_DAYS) return "aging";
  return "fresh";
}

function statusColor(status: FreshnessStatus): ThemeColor {
  switch (status) {
    case "fresh":
      return "success";
    case "aging":
      return "warning";
    case "stale":
      return "error";
    case "unknown":
      return "muted";
  }
}

function resourceStatusRank(status: FreshnessStatus): number {
  switch (status) {
    case "stale":
      return 0;
    case "aging":
      return 1;
    case "fresh":
      return 2;
    case "unknown":
      return 3;
  }
}

function compareRows(a: ExtensionFreshnessRow, b: ExtensionFreshnessRow): number {
  const rank = resourceStatusRank(a.status) - resourceStatusRank(b.status);
  if (rank !== 0) return rank;
  const ageDelta = (b.ageDays ?? -1) - (a.ageDays ?? -1);
  if (ageDelta !== 0) return ageDelta;
  return a.label.localeCompare(b.label);
}

function formatSourceLabel(source: string, scope: string): string {
  if (source.startsWith("npm:")) return source.slice("npm:".length) || source;
  if (source.startsWith("git:")) {
    return source
      .slice("git:".length)
      .replace(/^github\.com[/:]/, "")
      .replace(/\.git$/, "");
  }
  if (source === "local" || source === "auto") return `${source}:${scope}`;
  return source;
}

function formatPathForDisplay(path: string, cwd: string): string {
  if (path.startsWith("<")) return path;
  const resolvedPath = resolve(path);
  const resolvedCwd = resolve(cwd);
  if (resolvedPath === resolvedCwd) return ".";
  if (resolvedPath.startsWith(`${resolvedCwd}${sep}`)) return toPosix(relative(resolvedCwd, resolvedPath));
  const home = homedir();
  if (resolvedPath === home) return "~";
  if (resolvedPath.startsWith(`${home}${sep}`)) return `~/${toPosix(relative(home, resolvedPath))}`;
  return resolvedPath;
}

function labelForResource(resource: ExtensionResource, cwd: string): string {
  if (resource.baseDir && isAbsolute(resource.baseDir) && isRealPath(resource.path)) {
    const rel = relative(resource.baseDir, resource.path);
    if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return toPosix(rel);
  }
  return formatPathForDisplay(resource.path, cwd);
}

function findGitRoot(startPath: string): string | undefined {
  let current = safeStat(startPath)?.isDirectory() ? resolve(startPath) : dirname(resolve(startPath));
  while (true) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function parseIsoDate(value: string): Date | undefined {
  const date = new Date(value.trim());
  return Number.isNaN(date.getTime()) ? undefined : date;
}

async function gitDateForPath(pi: ExtensionAPI, gitRoot: string, path: string): Promise<Date | undefined> {
  const relativePath = toPosix(relative(gitRoot, path));
  const pathResult = await pi.exec("git", ["log", "-1", "--format=%cI", "--", relativePath], {
    cwd: gitRoot,
    timeout: 1_500,
  });
  const pathDate = parseIsoDate(pathResult.stdout);
  if (pathDate) return pathDate;

  const headResult = await pi.exec("git", ["log", "-1", "--format=%cI"], { cwd: gitRoot, timeout: 1_500 });
  return parseIsoDate(headResult.stdout);
}

async function lastUpdatedForResource(pi: ExtensionAPI, resource: ExtensionResource): Promise<UpdateInfo> {
  if (!isRealPath(resource.path)) return { source: "unknown" };

  const gitRoot = findGitRoot(resource.path);
  if (gitRoot) {
    try {
      const date = await gitDateForPath(pi, gitRoot, resource.path);
      if (date) return { date, source: "git" };
    } catch {
      // Fall back to local timestamps below.
    }
  }

  const pathStat = safeStat(resource.path);
  if (pathStat) return { date: pathStat.mtime, source: "file" };

  if (resource.baseDir) {
    const baseStat = safeStat(resource.baseDir);
    if (baseStat) return { date: baseStat.mtime, source: "file" };
  }

  return { source: "unknown" };
}

function addResource(resources: Map<string, ExtensionResource>, resource: ExtensionResource): void {
  if (!resource.path || resource.path.startsWith("<")) return;
  const key = canonicalKey(resource.path);
  if (!resources.has(key)) resources.set(key, resource);
}

function isExtensionSourceInfo(sourceInfo: SourceInfo | undefined): sourceInfo is SourceInfo {
  if (!sourceInfo?.path || sourceInfo.path.startsWith("<")) return false;
  if (sourceInfo.source === "builtin" || sourceInfo.source === "sdk") return false;
  return /\.[cm]?[jt]s$/i.test(sourceInfo.path);
}

function sourceInfoToResource(sourceInfo: SourceInfo | undefined): ExtensionResource | undefined {
  if (!isExtensionSourceInfo(sourceInfo)) return undefined;
  return {
    path: sourceInfo.path,
    source: sourceInfo.source,
    scope: sourceInfo.scope,
    origin: sourceInfo.origin,
    baseDir: sourceInfo.baseDir,
  };
}

async function discoverExtensionResources(pi: ExtensionAPI, ctx: ExtensionContext): Promise<ExtensionResource[]> {
  const resources = new Map<string, ExtensionResource>();

  try {
    const agentDir = getAgentDir();
    const settingsManager = SettingsManager.create(ctx.cwd, agentDir, { projectTrusted: ctx.isProjectTrusted() });
    const packageManager = new DefaultPackageManager({ cwd: ctx.cwd, agentDir, settingsManager });
    const resolved = await packageManager.resolve(async () => "skip");
    for (const extension of resolved.extensions.filter((entry: ResolvedResource) => entry.enabled)) {
      addResource(resources, {
        path: extension.path,
        source: extension.metadata.source,
        scope: extension.metadata.scope,
        origin: extension.metadata.origin,
        baseDir: extension.metadata.baseDir,
      });
    }
  } catch {
    // Runtime source metadata below still gives the panel useful coverage.
  }

  for (const command of pi.getCommands()) {
    if (command.source !== "extension") continue;
    const resource = sourceInfoToResource(command.sourceInfo);
    if (resource) addResource(resources, resource);
  }

  for (const tool of pi.getAllTools()) {
    const resource = sourceInfoToResource(tool.sourceInfo);
    if (resource) addResource(resources, resource);
  }

  return Array.from(resources.values());
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, mapper: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

async function buildReport(pi: ExtensionAPI, ctx: ExtensionContext): Promise<ExtensionFreshnessReport> {
  const now = new Date();
  const resources = await discoverExtensionResources(pi, ctx);
  const rows = await mapWithConcurrency(resources, 4, async (resource) => {
    const update = await lastUpdatedForResource(pi, resource);
    const ageDays = daysSince(update.date, now);
    const status = statusForAge(ageDays);
    return {
      ...resource,
      label: labelForResource(resource, ctx.cwd),
      sourceLabel: formatSourceLabel(resource.source, resource.scope),
      updatedAt: update.date?.toISOString(),
      updatedDate: formatDate(update.date),
      ageDays,
      age: formatAge(ageDays),
      status,
      freshnessSource: update.source,
    } satisfies ExtensionFreshnessRow;
  });

  rows.sort(compareRows);

  const counts: Record<FreshnessStatus, number> = { fresh: 0, aging: 0, stale: 0, unknown: 0 };
  for (const row of rows) counts[row.status] += 1;

  return { generatedAt: now.toISOString(), rows, counts };
}

function summaryText(report: ExtensionFreshnessReport): string {
  const parts = [
    `${report.rows.length} ext`,
    `${report.counts.fresh} fresh`,
    `${report.counts.aging} aging`,
    `${report.counts.stale} stale`,
  ];
  if (report.counts.unknown > 0) parts.push(`${report.counts.unknown} unknown`);
  return parts.join(" · ");
}

function renderPlain(report: ExtensionFreshnessReport): string {
  const lines = [`Extension freshness: ${summaryText(report)}`];
  for (const row of report.rows) {
    lines.push(`  ${row.updatedDate.padEnd(10)} ${row.age.padStart(6)} ${row.label} (${row.sourceLabel})`);
  }
  return lines.join("\n");
}

function renderRows(report: ExtensionFreshnessReport, theme: Theme, width: number, expanded: boolean): string[] {
  const rows = expanded ? report.rows : report.rows.slice(0, MAX_COLLAPSED_ROWS);
  const dateWidth = 10;
  const ageWidth = 6;
  const sourceWidth = expanded ? Math.min(26, Math.max(12, Math.floor(width * 0.24))) : 0;
  const gapWidth = expanded ? 8 : 6;
  const labelWidth = Math.max(12, width - dateWidth - ageWidth - sourceWidth - gapWidth);
  const lines: string[] = [];

  const heading = theme.fg("mdHeading", "[Extension freshness]");
  const summary = theme.fg("dim", summaryText(report));
  lines.push(`${heading} ${summary}`);
  lines.push(
    theme.fg("dim", `  green <${FRESH_DAYS}d · yellow ${FRESH_DAYS}-${STALE_DAYS - 1}d · red ≥${STALE_DAYS}d · /extension-freshness`),
  );

  if (rows.length === 0) {
    lines.push(theme.fg("muted", "  No extensions found."));
    return lines;
  }

  for (const row of rows) {
    const color = statusColor(row.status);
    const date = theme.fg(color, padTo(row.updatedDate, dateWidth));
    const age = theme.fg(color, padStartVisible(row.age, ageWidth));
    const label = theme.fg(row.status === "unknown" ? "muted" : "text", padTo(row.label, labelWidth));
    if (expanded) {
      const source = theme.fg("dim", truncatePlain(row.sourceLabel, sourceWidth));
      const sourceNote = theme.fg("dim", row.freshnessSource === "git" ? "git" : row.freshnessSource);
      lines.push(`  ${date}  ${age}  ${label}  ${source}  ${sourceNote}`);
    } else {
      lines.push(`  ${date}  ${age}  ${label}`);
    }
  }

  const remaining = report.rows.length - rows.length;
  if (remaining > 0) {
    lines.push(theme.fg("dim", `  +${remaining} more · expand startup/tools for all sources`));
  }

  return lines;
}

function createFreshnessComponent(report: ExtensionFreshnessReport, theme: Theme, expanded: boolean): Component {
  let cachedWidth = -1;
  let cachedLines: string[] = [];
  return {
    render(width: number): string[] {
      if (width !== cachedWidth) {
        cachedWidth = width;
        cachedLines = renderRows(report, theme, Math.max(36, width), expanded);
      }
      return cachedLines;
    },
    invalidate(): void {
      cachedWidth = -1;
      cachedLines = [];
    },
  };
}

function shouldShowForSession(reason: string): boolean {
  return reason === "startup" || reason === "new";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function sendFreshnessReport(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  const report = await buildReport(pi, ctx);
  pi.sendMessage(
    {
      customType: CUSTOM_TYPE,
      content: renderPlain(report),
      display: true,
      details: report,
    },
    { triggerTurn: false },
  );
}

export default function extensionFreshness(pi: ExtensionAPI): void {
  const shownSessions = new Set<string>();

  pi.registerMessageRenderer<ExtensionFreshnessReport>(CUSTOM_TYPE, (message, options, theme) => {
    const report = message.details;
    if (!report || !Array.isArray(report.rows)) return undefined;
    return createFreshnessComponent(report, theme, options.expanded === true);
  });

  pi.on("context", async (event) => {
    const messages = event.messages.filter(
      (message) => !(message.role === "custom" && (message as { customType?: string }).customType === CUSTOM_TYPE),
    );
    if (messages.length !== event.messages.length) return { messages: messages as never };
  });

  pi.on("session_start", async (event, ctx) => {
    if (ctx.mode !== "tui" || !shouldShowForSession(event.reason)) return;

    const sessionId = ctx.sessionManager.getSessionId?.() ?? `${event.reason}:${ctx.sessionManager.getSessionFile() ?? ctx.cwd}`;
    if (shownSessions.has(sessionId)) return;
    shownSessions.add(sessionId);

    try {
      await sendFreshnessReport(pi, ctx);
    } catch (error) {
      ctx.ui.notify(`pi-extension-freshness: ${errorMessage(error)}`, "warning");
    }
  });

  pi.registerCommand("extension-freshness", {
    description: "Show loaded extension last-updated dates and age colors",
    handler: async (_args, ctx) => {
      try {
        await sendFreshnessReport(pi, ctx);
      } catch (error) {
        ctx.ui.notify(`pi-extension-freshness: ${errorMessage(error)}`, "error");
      }
    },
  });
}
