// Packages Neural as a Mac app: bundles the desktop app and the kernel into two
// files, copies in what they load at runtime (UI, on-device model helper, the
// embedding model and its WebAssembly runtime), then runs electron-builder.
// Usage: npm run package   →   release/dist/Neural-<version>-arm64.dmg
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const stage = join(root, "release", "app");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;

rmSync(join(root, "release"), { recursive: true, force: true });
mkdirSync(join(stage, "dist"), { recursive: true });

const bundle = (entry, out) =>
  build({
    entryPoints: [join(root, entry)],
    outfile: join(stage, out),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    external: ["electron"],
    // Some dependencies are CommonJS and call require().
    banner: { js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);' },
    logLevel: "warning",
  });
await bundle("apps/desktop/dist/main.js", "dist/main.js");
await bundle("packages/kernel/dist/main.js", "dist/kernel.js");
await bundle("packages/cli/dist/mcp.js", "dist/uab-mcp.js");

const copy = (from, to) => {
  if (!existsSync(join(root, from))) throw new Error(`Missing ${from}. Run npm run build first.`);
  cpSync(join(root, from), join(stage, to), { recursive: true });
};
copy("apps/desktop/ui", "ui");
copy("apps/desktop/preload.cjs", "preload.cjs");
copy("docs/gmail-setup.md", "docs/gmail-setup.md");
copy("packages/gateway/native/bin/uab-apple-model", "bin/uab-apple-model");
copy("packages/kernel/models/all-MiniLM-L6-v2", "models/all-MiniLM-L6-v2");
for (const f of ["ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.wasm"]) copy(`node_modules/onnxruntime-web/dist/${f}`, `ort/${f}`);

writeFileSync(
  join(stage, "package.json"),
  JSON.stringify({ name: "neural", productName: "Neural", version, description: "Neural: an AI that gets things done, with a trusted kernel that asks before anything important.", main: "dist/main.js", type: "module", license: "Apache-2.0", author: "Unified AI Base contributors" }, null, 2),
);

execFileSync(join(root, "node_modules", ".bin", "electron-builder"), ["--config", "electron-builder.yml", "--mac"], { cwd: root, stdio: "inherit", env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "false" } });
console.log(`\nDone: release/dist/Neural-${version}-arm64.dmg`);
