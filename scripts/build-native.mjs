// Builds the Apple on-device model helper on macOS. Skipped elsewhere or without Xcode tools.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "packages/gateway/native/apple/main.swift");
const out = join(root, "packages/gateway/native/bin/uab-apple-model");

if (process.platform !== "darwin") {
  console.log("[native] not macOS: skipping the Apple on-device model helper");
  process.exit(0);
}
if (existsSync(out) && statSync(out).mtimeMs > statSync(src).mtimeMs) process.exit(0);

try {
  execFileSync("xcrun", ["--find", "swiftc"], { stdio: "ignore" });
} catch {
  console.warn("[native] Xcode command line tools not found: skipping the Apple on-device model helper");
  process.exit(0);
}

mkdirSync(dirname(out), { recursive: true });
console.log("[native] building the Apple on-device model helper…");
execFileSync("xcrun", ["swiftc", "-O", "-parse-as-library", "-o", out, src], { stdio: "inherit" });
