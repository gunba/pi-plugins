import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type Mode = "off" | "stock" | "pi" | "codex";

export function readMode(value: unknown): Mode {
  if (typeof value === "string" && ["off", "stock", "pi", "codex"].includes(value)) return value as Mode;
  throw new Error("codex-wire must be off, stock, pi or codex");
}

export function readDefaultMode(directory: string): Mode {
  try { return readMode(readFileSync(join(directory, "default-mode"), "utf8").trim()); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "off";
    throw error;
  }
}

export function saveDefaultMode(directory: string, value: unknown): void {
  const mode = readMode(value);
  saveSetting(directory, "default-mode", mode);
}

export function readUserAgent(directory: string): string | undefined {
  try { return readFileSync(join(directory, "user-agent"), "utf8").trim(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

export function saveUserAgent(directory: string, value: string): void {
  if (!value || !/^[\x20-\x7e]+$/.test(value)) throw new Error("User-Agent must be a nonempty printable single line");
  saveSetting(directory, "user-agent", value);
}

function saveSetting(directory: string, name: string, value: string): void {
  mkdirSync(directory, { recursive: true });
  const temporary = join(directory, `${name}.${randomUUID()}.tmp`);
  writeFileSync(temporary, `${value}\n`, { flag: "wx", mode: 0o600 });
  try { renameSync(temporary, join(directory, name)); }
  finally { rmSync(temporary, { force: true }); }
}
