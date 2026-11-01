import { readdir, stat, readFile, realpath } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, extname, basename, sep } from "node:path";
import { homedir } from "node:os";
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

interface Hit {
  path: string;
  size: number;
  modified: string;
}

/**
 * Walk folders and collect matching files. Shared folders that can't be read
 * (usually because macOS hasn't given this app access) are reported, not skipped silently.
 */
async function walkFolders(roots: string[], match: (name: string) => boolean, opts: { maxDepth: number; maxHits: number }) {
  const hits: Hit[] = [];
  const blocked: string[] = [];
  const deadline = Date.now() + 4000;

  async function walk(dir: string, depth: number, isRoot: boolean): Promise<void> {
    if (depth > opts.maxDepth || hits.length >= opts.maxHits || Date.now() > deadline) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (isRoot) blocked.push(`${dir} (${(err as NodeJS.ErrnoException).code === "ENOENT" ? "doesn't exist" : "macOS hasn't allowed this app to read it"})`);
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") || SKIP.has(e.name)) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) await walk(full, depth + 1, false);
      else if (e.isFile() && match(e.name.toLowerCase())) {
        const s = await stat(full).catch(() => null);
        // For downloads the file's arrival (birth) time matters more than its modified time.
        if (s) hits.push({ path: full, size: s.size, modified: new Date(Math.max(s.mtimeMs, s.birthtimeMs)).toISOString() });
      }
    }
  }

  for (const root of roots) await walk(root, 0, true);
  hits.sort((a, b) => b.modified.localeCompare(a.modified));
  return { hits, blocked };
}

function listing(hits: Hit[]): string {
  return hits.map((h) => `${h.path}  (${Math.ceil(h.size / 1024)} KB, ${h.modified.slice(0, 16).replace("T", " ")})`).join("\n");
}

function blockedNote(blocked: string[]): string {
  return blocked.length
    ? `\nCould not read: ${blocked.join("; ")}. If macOS blocked it, the user can allow it in System Settings → Privacy & Security → Files & Folders.`
    : "";
}

/** "Downloads", "downloads", or a full path → a shared folder (or a folder inside one). */
async function resolveFolder(folder: string, ctx: ProviderContext): Promise<string> {
  const roots = ctx.policy().fileRoots;
  if (folder.startsWith("/") || folder.startsWith("~")) return insideRoots(folder.replace(/^~/, homedir()), ctx);
  const byName = roots.find((r) => basename(r).toLowerCase() === folder.toLowerCase());
  if (byName) return byName;
  for (const root of roots) {
    const candidate = join(root, folder);
    if (await stat(candidate).then((s) => s.isDirectory()).catch(() => false)) return insideRoots(candidate, ctx);
  }
  throw new Error(`No shared folder called "${folder}". Shared folders: ${roots.join(", ")}`);
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
      const words = str(args, "query").toLowerCase().split(/\s+/).filter(Boolean);
      const { hits, blocked } = await walkFolders(ctx.policy().fileRoots, (name) => words.every((w) => name.includes(w)), { maxDepth: 6, maxHits: limit * 4 });
      const top = hits.slice(0, limit);
      if (!top.length) return { content: `No files with "${args.query}" in their name in: ${ctx.policy().fileRoots.join(", ")}.${blockedNote(blocked)}`, data: [] };
      return { content: listing(top) + blockedNote(blocked), data: top };
    },
  },
  {
    id: "files.recent",
    service: "files",
    title: "Recent files",
    description:
      "List the newest files in a shared folder, newest first. Use this for questions like 'latest downloads' or 'what did I save today'. Folder can be a name like 'Downloads' or a full path; leave it out for all shared folders.",
    inputSchema: {
      type: "object",
      properties: {
        folder: { type: "string", description: "e.g. 'Downloads', 'Desktop', or a full path" },
        limit: { type: "number", description: "How many files (default 10)" },
      },
    },
    effects: ["read"],
    risk: "low",
    summarize: (a) => `List the newest files in ${a.folder ?? "your shared folders"}`,
    async run(args, ctx) {
      const limit = typeof args.limit === "number" ? Math.max(1, Math.min(args.limit, 50)) : 10;
      const folder = str(args, "folder", false);
      const roots = folder ? [await resolveFolder(folder, ctx)] : ctx.policy().fileRoots;
      // Recent files are usually near the top; don't wander deep into project folders.
      const { hits, blocked } = await walkFolders(roots, () => true, { maxDepth: folder ? 2 : 1, maxHits: 5000 });
      const top = hits.slice(0, limit);
      if (!top.length) return { content: `No files found in ${roots.join(", ")}.${blockedNote(blocked)}`, data: [] };
      return { content: listing(top) + blockedNote(blocked), data: top };
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
