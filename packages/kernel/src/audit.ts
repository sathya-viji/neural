import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { AuditEntry } from "@uab/protocol";

const GENESIS = "0".repeat(64);

function hashEntry(entry: Omit<AuditEntry, "hash">): string {
  return createHash("sha256").update(JSON.stringify(entry)).digest("hex");
}

/** Keep the history readable: long values are shortened, never dropped. */
function compact(value: unknown): unknown {
  if (typeof value === "string") return value.length > 2000 ? `${value.slice(0, 2000)}… [${value.length} chars]` : value;
  if (Array.isArray(value)) return value.map(compact);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, compact(v)]));
  }
  return value;
}

/** Append-only activity history. Each entry includes the hash of the one before. */
export class AuditLog {
  private path: string;
  private entries: AuditEntry[] = [];

  constructor(home: string) {
    this.path = join(home, "audit.jsonl");
    if (existsSync(this.path)) {
      for (const line of readFileSync(this.path, "utf8").split("\n")) {
        if (line.trim()) this.entries.push(JSON.parse(line));
      }
    }
  }

  append(fields: Omit<AuditEntry, "seq" | "time" | "prevHash" | "hash">): AuditEntry {
    const prev = this.entries.at(-1);
    const base: Omit<AuditEntry, "hash"> = {
      seq: (prev?.seq ?? 0) + 1,
      time: new Date().toISOString(),
      ...fields,
      args: compact(fields.args) as Record<string, unknown>,
      prevHash: prev?.hash ?? GENESIS,
    };
    const entry: AuditEntry = { ...base, hash: hashEntry(base) };
    appendFileSync(this.path, JSON.stringify(entry) + "\n", { mode: 0o600 });
    this.entries.push(entry);
    return entry;
  }

  list(limit = 200): AuditEntry[] {
    return this.entries.slice(-limit).reverse();
  }

  verify(): { ok: boolean; entries: number; brokenAt?: number } {
    let prevHash = GENESIS;
    for (const e of this.entries) {
      const { hash, ...rest } = e;
      if (rest.prevHash !== prevHash || hashEntry(rest) !== hash) {
        return { ok: false, entries: this.entries.length, brokenAt: e.seq };
      }
      prevHash = hash;
    }
    return { ok: true, entries: this.entries.length };
  }
}
