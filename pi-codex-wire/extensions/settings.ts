import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "./identity.ts";

export function readClient(value: unknown): Client {
  if (value === "cli" || value === "desktop") return value;
  throw new Error("Codex wire client must be cli or desktop");
}

export function savedClient(directory: string): Client {
  try { return readClient(readFileSync(join(directory, "client"), "utf8").trim()); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return "cli"; throw error; }
}

export function saveClient(directory: string, client: Client): void {
  saveSetting(directory, "client", readClient(client));
}

export function readPrewarm(value: unknown): boolean {
  if (value === "on") return true;
  if (value === "off") return false;
  throw new Error("Codex Wire prewarm must be on or off");
}

export function savedPrewarm(directory: string): "on" | "off" {
  try {
    return readPrewarm(readFileSync(join(directory, "prewarm"), "utf8").trim()) ? "on" : "off";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "off";
    throw error;
  }
}

export function savePrewarm(directory: string, enabled: boolean): void {
  saveSetting(directory, "prewarm", enabled ? "on" : "off");
}

export function readUserAgent(directory: string, client: Client = "cli"): string | undefined {
  try { return readFileSync(join(directory, client === "desktop" ? "user-agent-desktop" : "user-agent"), "utf8").trim(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

export function saveUserAgent(directory: string, value: string, client: Client = "cli"): void {
  if (!value || !/^[\x20-\x7e]+$/.test(value)) throw new Error("User-Agent must be a nonempty printable single line");
  saveSetting(directory, client === "desktop" ? "user-agent-desktop" : "user-agent", value);
}

function saveSetting(directory: string, name: string, value: string): void {
  mkdirSync(directory, { recursive: true });
  const temporary = join(directory, `${name}.${randomUUID()}.tmp`);
  writeFileSync(temporary, `${value}\n`, { flag: "wx", mode: 0o600 });
  try { renameSync(temporary, join(directory, name)); }
  finally { rmSync(temporary, { force: true }); }
}
