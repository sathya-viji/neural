import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { readJson, writeJson } from "./store.js";

const run = promisify(execFile);
const SERVICE = "unified-ai-base";

/**
 * Secrets (API keys, tokens). On macOS they live in the system Keychain.
 * Elsewhere they fall back to a file only this user can read.
 * Models never receive secrets; only the kernel and trusted host code do.
 */
export class Vault {
  private filePath: string;
  private useKeychain = process.platform === "darwin" && !process.env.UAB_VAULT_FILE;

  constructor(home: string) {
    this.filePath = join(home, "vault.json");
  }

  async set(name: string, value: string): Promise<void> {
    if (this.useKeychain) {
      await run("security", ["add-generic-password", "-U", "-s", SERVICE, "-a", name, "-w", value]);
      return;
    }
    const data = readJson<Record<string, string>>(this.filePath, {});
    data[name] = value;
    writeJson(this.filePath, data);
  }

  async get(name: string): Promise<string | null> {
    if (this.useKeychain) {
      try {
        const { stdout } = await run("security", ["find-generic-password", "-s", SERVICE, "-a", name, "-w"]);
        return stdout.replace(/\n$/, "");
      } catch {
        return null;
      }
    }
    return readJson<Record<string, string>>(this.filePath, {})[name] ?? null;
  }

  async has(name: string): Promise<boolean> {
    return (await this.get(name)) !== null;
  }

  async remove(name: string): Promise<void> {
    if (this.useKeychain) {
      await run("security", ["delete-generic-password", "-s", SERVICE, "-a", name]).catch(() => {});
    } else {
      const data = readJson<Record<string, string>>(this.filePath, {});
      delete data[name];
      writeJson(this.filePath, data);
    }
  }

  /**
   * Names of the secrets that hold something, from a list of names to check.
   * Only names: values never leave this class except to the code that uses them.
   */
  async present(candidates: string[]): Promise<string[]> {
    const names = this.useKeychain ? candidates : [...new Set([...candidates, ...Object.keys(readJson<Record<string, string>>(this.filePath, {}))])];
    const found = await Promise.all(
      names.map(async (n) => {
        const v = await this.get(n);
        return v !== null && !["", "null", "{}"].includes(v.trim()) ? n : null;
      }),
    );
    return found.filter((n): n is string => !!n);
  }

  /** Replace "vault:NAME" references in service config with real values. */
  async resolveRefs(env: Record<string, string> = {}): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(env)) {
      if (v.startsWith("vault:")) {
        const secret = await this.get(v.slice("vault:".length));
        if (secret === null) throw new Error(`Secret "${v.slice(6)}" is not in the vault`);
        out[k] = secret;
      } else {
        out[k] = v;
      }
    }
    return out;
  }
}
