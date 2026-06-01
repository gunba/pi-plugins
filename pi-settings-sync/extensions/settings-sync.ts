import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

// The deterministic work lives in scripts/pi-settings-sync.mjs so the exact same
// engine powers both this command and the import skill. This command is a thin
// spawner that runs the engine with the same Node that runs Pi.
const ENGINE = join(dirname(dirname(fileURLToPath(import.meta.url))), "scripts", "pi-settings-sync.mjs");

type ExportResult = {
  ok: boolean;
  error?: string;
  zipPath?: string;
  fileCount?: number;
  bytes?: number;
  tokenizedCount?: number;
  warnings?: string[];
};

function runExport(out: string | undefined): Promise<ExportResult> {
  const args = [ENGINE, "export", "--json"];
  if (out) args.push("--out", out);

  return new Promise((resolve) => {
    const proc = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");
    proc.stdout.on("data", (chunk) => { stdout += chunk; });
    proc.stderr.on("data", (chunk) => { stderr += chunk; });
    proc.on("error", (err) => resolve({ ok: false, error: err.message }));
    proc.on("close", (code) => {
      const trimmed = stdout.trim();
      const lastLine = trimmed.split(/\r?\n/).filter(Boolean).pop() ?? "";
      try {
        const parsed = JSON.parse(lastLine) as ExportResult;
        if (!parsed.ok && !parsed.error && stderr.trim()) parsed.error = stderr.trim();
        resolve(parsed);
      } catch {
        resolve({ ok: false, error: stderr.trim() || trimmed || `engine exited with code ${code}` });
      }
    });
  });
}

async function handleExport(args: string, ctx: ExtensionCommandContext): Promise<void> {
  const out = args.trim() || undefined;
  ctx.ui.notify("Exporting Pi settings…", "info");

  const result = await runExport(out);
  if (!result.ok) {
    ctx.ui.notify(`Settings export failed: ${result.error ?? "unknown error"}`, "error");
    return;
  }

  const kb = ((result.bytes ?? 0) / 1024).toFixed(1);
  ctx.ui.notify(`Exported ${result.fileCount ?? 0} settings file(s) → ${result.zipPath} (${kb} KB)`, "info");
  if (result.warnings?.length) {
    ctx.ui.notify(`Export warnings: ${result.warnings.join("; ")}`, "warning");
  }
  ctx.ui.notify("Excludes node_modules, caches, sessions, and auth. Import the zip on another machine with /pi-settings-import.", "info");
}

export default function (pi: ExtensionAPI) {
  const description = "Export user-level Pi settings (skills, agents, themes, MCP, config) to a portable zip on the Desktop";
  pi.registerCommand("pi-export", { description, handler: handleExport });
  pi.registerCommand("pi-settings-export", { description: `${description} (alias of /pi-export)`, handler: handleExport });
}
