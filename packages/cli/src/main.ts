#!/usr/bin/env node
/**
 * uab "find the q3 report and email it to sam"
 * uab --activity        show the activity history
 * uab --services        show connected services
 */
import { createInterface } from "node:readline/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { readFileSync, existsSync } from "node:fs";
import { KernelClient } from "@uab/kernel/client";
import { Gateway, createProvider, defaultModelSettings, type ModelSettings } from "@uab/gateway";

const home = process.env.UAB_HOME || join(homedir(), ".uab");
const settingsPath = join(home, "settings.json");
const settings: ModelSettings = existsSync(settingsPath)
  ? { ...defaultModelSettings(), ...JSON.parse(readFileSync(settingsPath, "utf8")).models }
  : defaultModelSettings();

const kernel = new KernelClient({ onLog: (l) => process.env.UAB_DEBUG && console.error(l) });
await kernel.start();
const rl = createInterface({ input: process.stdin, output: process.stdout });

// The approval prompt is drawn from kernel data only.
kernel.onEvent("approval.requested", async (req) => {
  console.log(`\n┌─ Kernel: approval needed ──────────────────────`);
  console.log(`│ ${req.summary}`);
  console.log(`│ Service: ${req.capability.service}   Risk: ${req.capability.risk}   Effects: ${req.capability.effects.join(", ")}`);
  console.log(`│ Requested by: ${req.model ?? req.source}`);
  console.log(`└────────────────────────────────────────────────`);
  const answer = (await rl.question("Allow? [y/N] ")).trim().toLowerCase();
  await kernel.call("approvals.resolve", { approvalId: req.approvalId, approve: answer === "y" || answer === "yes" });
});

const arg = process.argv.slice(2).join(" ").trim();
try {
  if (arg === "--activity") {
    for (const e of await kernel.call("audit.list", { limit: 30 })) {
      console.log(`${e.time.slice(0, 19)}  ${e.outcome.padEnd(8)} ${e.capability.padEnd(22)} ${e.detail.split("\n")[0].slice(0, 80)}`);
    }
    const v = await kernel.call("audit.verify", {});
    console.log(v.ok ? `\nHistory intact (${v.entries} entries).` : `\nHistory broken at entry ${v.brokenAt}!`);
  } else if (arg === "--services") {
    for (const s of await kernel.call("services.list", {})) {
      console.log(`${s.status === "connected" ? "●" : "○"} ${s.title.padEnd(24)} ${s.kind.padEnd(8)} ${s.capabilityCount} capabilities${s.error ? `  (${s.error})` : ""}`);
    }
  } else if (!arg) {
    console.log('Usage: uab "what you want done"   |   uab --activity   |   uab --services');
  } else {
    const key = settings.active === "cloud" ? (await kernel.call("vault.getModelKey", { name: "model.cloud" })).value ?? process.env.ANTHROPIC_API_KEY ?? null : null;
    const gateway = new Gateway(kernel, createProvider(settings, key, kernel));
    await gateway.run(arg, {
      onEvent(e) {
        if (e.type === "task") console.log(`Using ${e.model} (${e.locality})`);
        if (e.type === "thinking") console.log(`… ${e.text}`);
        if (e.type === "proposal") console.log(`→ ${e.capability.title}`);
        if (e.type === "decision") {
          const d = e.decision;
          console.log(`  ${d.status === "executed" ? "✓ done" : d.status === "denied" ? `✗ ${d.reason}` : `! ${d.error}`}`);
        }
        if (e.type === "done") console.log(`\n${e.text}`);
      },
    });
  }
} finally {
  rl.close();
  kernel.stop();
}
