import type { ActionResult, Capability, Policy } from "@uab/protocol";
import type { Vault } from "../vault.js";

export interface ProviderContext {
  home: string;
  policy(): Policy;
  /** For services that need a stored key or account. */
  vault?: Vault;
}

/** A capability implemented inside the kernel process itself. */
export interface BuiltinCapability extends Capability {
  run(args: Record<string, unknown>, ctx: ProviderContext): Promise<ActionResult>;
  /** Offered to models only while this returns true (e.g. an account is connected). */
  available?(): boolean;
  /** Check the action really happened. Absent means "trust the result". */
  verify?(args: Record<string, unknown>, result: ActionResult, ctx: ProviderContext): Promise<boolean>;
  /**
   * One plain sentence for the approval card. Written by the kernel, never by a model.
   * May look things up (e.g. the titles behind ids) so the card shows what will really happen.
   */
  summarize?(args: Record<string, unknown>): string | Promise<string>;
}

export function str(args: Record<string, unknown>, key: string, required = true): string {
  const v = args[key];
  if (typeof v === "string" && v.trim()) return v;
  if (required) throw new Error(`"${key}" is required`);
  return "";
}

export function strList(args: Record<string, unknown>, key: string): string[] {
  const v = args[key];
  if (v === undefined || v === null) return [];
  if (typeof v === "string") return v.split(",").map((s) => s.trim()).filter(Boolean);
  if (Array.isArray(v)) return v.map(String);
  throw new Error(`"${key}" must be a list`);
}
