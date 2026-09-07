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
  mkdirSync(directory, { recursive: true });
  const temporary = join(directory, `default-mode.${randomUUID()}.tmp`);
  writeFileSync(temporary, `${mode}\n`, { flag: "wx", mode: 0o600 });
  try { renameSync(temporary, join(directory, "default-mode")); }
  finally { rmSync(temporary, { force: true }); }
}
