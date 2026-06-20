import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const execFileAsync = promisify(execFile);
const MAX_SCREENSHOT_BYTES = 16 * 1024 * 1024;

type ScreenshotMode = "fullscreen" | "current" | "active-window";

function commandFor(mode: ScreenshotMode, outputPath: string): { command: string; args: string[] }[] {
  const spectacleMode = mode === "active-window" ? "--activewindow" : mode === "current" ? "--current" : "--fullscreen";
  return [
    { command: "spectacle", args: ["--background", "--nonotify", spectacleMode, "--output", outputPath] },
    { command: "gnome-screenshot", args: ["--file", outputPath] },
    { command: "grim", args: [outputPath] },
    { command: "import", args: ["-window", "root", outputPath] },
  ];
}

async function captureScreenshot(mode: ScreenshotMode): Promise<{ data: string; bytes: number; path: string; command: string }> {
  const dir = await mkdtemp(join(tmpdir(), "pi-screenshot-"));
  const path = join(dir, "screenshot.png");
  const errors: string[] = [];
  try {
    for (const candidate of commandFor(mode, path)) {
      try {
        await execFileAsync(candidate.command, candidate.args, { timeout: 30_000, maxBuffer: 256 * 1024 });
        const buffer = await readFile(path);
        if (!buffer.length) throw new Error("screenshot file was empty");
        if (buffer.length > MAX_SCREENSHOT_BYTES) throw new Error(`screenshot was ${buffer.length} bytes, over ${MAX_SCREENSHOT_BYTES}`);
        return { data: buffer.toString("base64"), bytes: buffer.length, path, command: candidate.command };
      } catch (error) {
        errors.push(`${candidate.command}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    throw new Error(`No screenshot command succeeded. Tried: ${errors.join(" | ")}`);
  } finally {
    // Best effort cleanup. The image bytes have already been loaded.
    rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export default function screenshot(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "host_screenshot",
    label: "Host Screenshot",
    description: "Capture the current desktop screen on the machine running Pi and return it as an image for visual inspection.",
    promptSnippet: "host_screenshot(mode?): capture the host desktop/current monitor/active window as an image",
    promptGuidelines: [
      "Use host_screenshot when the user asks what is on screen, wants visual debugging, or asks for a screenshot of the app being worked on.",
      "Do not call host_screenshot repeatedly unless the user asks for another fresh view or the screen changed materially.",
    ],
    parameters: Type.Object({
      mode: Type.Optional(Type.Union([
        Type.Literal("fullscreen"),
        Type.Literal("current"),
        Type.Literal("active-window"),
      ], { description: "Screenshot target. fullscreen is the default." })),
    }),
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      const mode = (params.mode ?? "fullscreen") as ScreenshotMode;
      try {
        const shot = await captureScreenshot(mode);
        return {
          content: [
            { type: "text", text: `Captured ${mode} screenshot from host using ${shot.command} (${shot.bytes} bytes).` },
            { type: "image", data: shot.data, mimeType: "image/png" },
          ],
          details: { mode, bytes: shot.bytes, command: shot.command },
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Failed to capture host screenshot: ${error instanceof Error ? error.message : String(error)}` }],
          details: { mode, bytes: 0, command: "none" },
          isError: true,
        };
      }
    },
  });
}
