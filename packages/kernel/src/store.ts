import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

/** Where the kernel keeps the user's data. Everything stays on this machine. */
export function resolveHome(): string {
  const home = process.env.UAB_HOME || join(homedir(), ".uab");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  return home;
}

export function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

/** Write via a temp file so a crash never leaves a half-written file. */
export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}
