import { homedir } from "node:os";
import { join } from "node:path";
import type { Capability, Permission, Policy, PolicyRule, Risk } from "@uab/protocol";
import { readJson, writeJson } from "./store.js";

const DEFAULT_BY_RISK: Record<Risk, Permission> = {
  low: "allow",
  medium: "ask",
  high: "ask",
};

/**
 * The user's permissions. Deterministic: the same capability and policy
 * always produce the same answer, whatever model is asking.
 */
export class PolicyStore {
  private path: string;
  private policy: Policy;

  constructor(home: string) {
    this.path = join(home, "policy.json");
    const h = homedir();
    this.policy = readJson<Policy>(this.path, {
      rules: [],
      fileRoots: [join(h, "Documents"), join(h, "Desktop"), join(h, "Downloads")],
    });
  }

  get(): Policy {
    return structuredClone(this.policy);
  }

  setRule(rule: PolicyRule): void {
    this.policy.rules = this.policy.rules.filter((r) => r.target !== rule.target);
    this.policy.rules.push(rule);
    this.save();
  }

  setFileRoots(roots: string[]): void {
    this.policy.fileRoots = roots;
    this.save();
  }

  /** Exact capability rule, then service rule, then the default for its risk. */
  evaluate(cap: Capability): Permission {
    const exact = this.policy.rules.find((r) => r.target === cap.id);
    const service = this.policy.rules.find((r) => r.target === `service:${cap.service}`);
    let permission = exact?.permission ?? service?.permission ?? DEFAULT_BY_RISK[cap.risk];

    // Kernel invariant: spending money always needs the user, unless the user
    // explicitly allowed that exact capability.
    if (cap.effects.includes("spend") && permission === "allow" && exact?.permission !== "allow") {
      permission = "ask";
    }
    return permission;
  }

  private save(): void {
    writeJson(this.path, this.policy);
  }
}
