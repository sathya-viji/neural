// Puts the small embedding model the kernel uses to pick relevant memories into
// packages/kernel/models/. It ships with the app; the kernel never downloads at runtime.
// Model: Xenova/all-MiniLM-L6-v2 (Apache-2.0), pinned to one revision and checked by hash.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = "Xenova/all-MiniLM-L6-v2";
const REVISION = "751bff37182d3f1213fa05d7196b954e230abad9";
const FILES = {
  "onnx/model_quantized.onnx": null,
  "tokenizer.json": null,
  "tokenizer_config.json": null,
  "config.json": null,
};
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "packages", "kernel", "models", "all-MiniLM-L6-v2");
const lockPath = join(root, "..", "all-MiniLM-L6-v2.sha256.json");
const lock = existsSync(lockPath) ? JSON.parse(readFileSync(lockPath, "utf8")) : {};

for (const file of Object.keys(FILES)) {
  const out = join(root, file);
  const sha = (buf) => createHash("sha256").update(buf).digest("hex");
  if (existsSync(out) && lock[file] === sha(readFileSync(out))) continue;
  const res = await fetch(`https://huggingface.co/${REPO}/resolve/${REVISION}/${file}`);
  if (!res.ok) throw new Error(`Couldn't download ${file}: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (lock[file] && lock[file] !== sha(buf)) throw new Error(`${file} doesn't match the expected hash`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, buf);
  lock[file] = sha(buf);
  console.log(`model: ${file} (${(buf.length / 1e6).toFixed(1)} MB)`);
}
writeFileSync(lockPath, JSON.stringify(lock, null, 2) + "\n");
