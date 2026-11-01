import { readdir, stat, readFile, realpath } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, extname, basename, sep } from "node:path";
import type { BuiltinCapability, ProviderContext } from "./types.js";
import { str } from "./types.js";

const run = promisify(execFile);
// Folders full of generated files that people never mean when they ask for "the report".
const SKIP = new Set(["node_modules", "Library", ".git", ".Trash", "build", "dist", "Pods", "DerivedData", "vendor", "__pycache__", "venv", "target"]);
const TEXT = new Set([".txt", ".md", ".csv", ".json", ".log", ".yaml", ".yml", ".xml", ".html", ".ts", ".js", ".py"]);
const CONVERTIBLE = new Set([".doc", ".docx", ".rtf", ".rtfd", ".odt", ".webarchive"]);

/** Resolve a path and make sure it sits inside one of the user's allowed folders. */
export async function insideRoots(path: string, ctx: ProviderContext): Promise<string> {
  const real = await realpath(path).catch(() => {
    throw new Error(`File not found: ${path}`);
  });
  for (const root of ctx.policy().fileRoots) {
    const r = await realpath(root).catch(() => null);
    if (r && (real === r || real.startsWith(r + sep))) return real;
  }
  throw new Error(`"${path}" is outside the folders you have shared. Add its folder under Permissions.`);
}

async function search(query: string, ctx: ProviderContext, limit: number) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hits: { path: string; size: number; modified: string }[] = [];
  const deadline = Date.now() + 4000;

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 6 || hits.length >= limit * 4 || Date.now() > deadline) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") || SKIP.has(e.name)) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) await walk(full, depth + 1);
      else if (e.isFile()) {
        const name = e.name.toLowerCase();
        if (words.every((w) => name.includes(w))) {
          const s = await stat(full).catch(() => null);
          if (s) hits.push({ path: full, size: s.size, modified: s.mtime.toISOString() });
        }
      }
    }
  }

  for (const root of ctx.policy().fileRoots) await walk(root, 0);
  return hits.sort((a, b) => b.modified.localeCompare(a.modified)).slice(0, limit);
}

export const fileCapabilities: BuiltinCapability[] = [
  {
    id: "files.search",
    service: "files",
    title: "Search files",
    description: "Find files by name inside the folders the user has shared. Matches every word in the query against the file name. Newest first.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Words that appear in the file name, e.g. 'q3 report'" },
        limit: { type: "number", description: "Maximum results (default 10)" },
      },
      required: ["query"],
    },
    effects: ["read"],
    risk: "low",
    summarize: (a) => `Search your shared folders for "${a.query}"`,
    async run(args, ctx) {
      const limit = typeof args.limit === "number" ? Math.min(args.limit, 50) : 10;
      const hits = await search(str(args, "query"), ctx, limit);
      if (!hits.length) return { content: `No files matching "${args.query}" in: ${ctx.policy().fileRoots.join(", ")}`, data: [] };
      const lines = hits.map((h) => `${h.path}  (${Math.ceil(h.size / 1024)} KB, modified ${h.modified.slice(0, 10)})`);
      return { content: lines.join("\n"), data: hits };
    },
  },
  {
    id: "files.read",
    service: "files",
    title: "Read a file",
    description: "Read the text of a file inside the shared folders. Works for plain text, Markdown, CSV, JSON, Word and RTF documents.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Full path from files.search" } },
      required: ["path"],
    },
    effects: ["read"],
    risk: "low",
    summarize: (a) => `Read ${basename(String(a.path))}`,
    async run(args, ctx) {
      const path = await insideRoots(str(args, "path"), ctx);
      const ext = extname(path).toLowerCase();
      let text: string;
      if (CONVERTIBLE.has(ext) && process.platform === "darwin") {
        text = (await run("textutil", ["-convert", "txt", "-stdout", path], { maxBuffer: 10_000_000 })).stdout;
      } else if (TEXT.has(ext) || ext === "") {
        text = await readFile(path, "utf8");
      } else {
        const s = await stat(path);
        return { content: `${basename(path)} is a ${ext || "binary"} file (${Math.ceil(s.size / 1024)} KB). Its text can't be read, but it can be attached or opened.` };
      }
      const max = 20_000;
      return { content: text.length > max ? `${text.slice(0, max)}\n… [truncated, ${text.length} characters total]` : text };
    },
  },
];
