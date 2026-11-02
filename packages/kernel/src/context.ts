import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Memory, Profile, TaskRecord } from "@uab/protocol";
import { readJson, writeJson } from "./store.js";

interface Saved {
  profile: Profile;
  memories: Memory[];
}

const MAX_MEMORIES = 200;
/** Requests where a delivery or home address is useful. */
const NEEDS_ADDRESS = /\b(deliver\w*|order\w*|food|eat|lunch|dinner|breakfast|restaurants?|zomato|swiggy|near (me|home)|nearby|home|address|ship\w*|cab|ride|taxi|uber|ola|directions?|route|commute)\b/i;
const WORD = /[a-z0-9]{3,}/g;

/**
 * Who the user is and what they asked the AI to remember. Kept by the kernel on
 * this computer, shown and editable in the app. The kernel decides how much of
 * it each request gets: everything for a model on this Mac; for a cloud model,
 * only what the request needs.
 */
export class ContextStore {
  private path: string;

  constructor(home: string) {
    this.path = join(home, "context.json");
  }

  get(): Saved {
    const saved = readJson<Partial<Saved>>(this.path, {});
    return { profile: saved.profile ?? {}, memories: saved.memories ?? [] };
  }

  setProfile(profile: Profile): Profile {
    const clean: Profile = {};
    for (const key of ["name", "city", "address", "language", "about"] as const) {
      const v = profile[key]?.toString().trim();
      if (v) clean[key] = v.slice(0, key === "about" ? 1000 : 300);
    }
    writeJson(this.path, { ...this.get(), profile: clean });
    return clean;
  }

  addMemory(text: string, source: Memory["source"]): Memory {
    text = text.trim().replace(/\s+/g, " ").slice(0, 300);
    if (!text) throw new Error("Nothing to remember.");
    const saved = this.get();
    const existing = saved.memories.find((m) => m.text.toLowerCase() === text.toLowerCase());
    if (existing) return existing;
    const memory: Memory = { id: randomUUID().slice(0, 8), text, createdAt: new Date().toISOString(), source };
    saved.memories = [...saved.memories, memory].slice(-MAX_MEMORIES);
    writeJson(this.path, saved);
    return memory;
  }

  removeMemory(id: string): Memory | undefined {
    const saved = this.get();
    const gone = saved.memories.find((m) => m.id === id);
    saved.memories = saved.memories.filter((m) => m.id !== id);
    writeJson(this.path, saved);
    return gone;
  }

  /** The saved memory that best matches a description, e.g. "that I'm vegetarian". */
  findMemory(description: string): Memory | undefined {
    const byId = this.get().memories.find((m) => m.id === description.trim());
    if (byId) return byId;
    return rank(this.get().memories, description)[0];
  }

  /**
   * The background the AI gets with a request. For cloud models the home address
   * goes only with requests that need it, and only memories that relate to the
   * request (or the newest few) are sent.
   */
  build(intent: string, opts: { cloud: boolean; recent?: TaskRecord[] }): string {
    const { profile, memories } = this.get();
    const lines: string[] = [];
    const about: string[] = [];
    if (profile.name) about.push(`- Name: ${profile.name}`);
    if (profile.city) about.push(`- Lives in: ${profile.city}`);
    if (profile.address && (!opts.cloud || NEEDS_ADDRESS.test(intent))) about.push(`- Home / delivery address: ${profile.address}`);
    if (profile.language) about.push(`- Prefers to be answered in: ${profile.language}`);
    if (profile.about) about.push(`- In their own words: ${profile.about}`);
    if (about.length) lines.push("About the person you're helping:", ...about);

    const shown = opts.cloud && memories.length > 12 ? pickRelevant(memories, intent, 10) : memories;
    if (shown.length) lines.push("", "Things they asked you to remember:", ...shown.map((m) => `- ${m.text}`));

    // What was done recently (today and yesterday), so "do that again" or "the same place" make sense.
    const since = Date.now() - 36 * 3600 * 1000;
    const recent = (opts.recent ?? []).filter((t) => t.summary && new Date(t.startedAt).getTime() > since).slice(0, 3);
    if (recent.length) {
      lines.push("", "Recently done (newest first):", ...recent.map((t) => `- "${t.intent.slice(0, 120)}" → ${t.summary!.replace(/\*\*/g, "").replace(/\s+/g, " ").slice(0, 160)}${t.summary!.length > 160 ? "…" : ""}`));
    }
    return lines.join("\n").trim();
  }
}

function words(text: string): Set<string> {
  return new Set(text.toLowerCase().match(WORD) ?? []);
}

function rank(memories: Memory[], query: string): Memory[] {
  const q = words(query);
  return memories
    .map((m) => ({ m, score: [...words(m.text)].filter((w) => q.has(w) || [...q].some((x) => x.startsWith(w) || w.startsWith(x))).length }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.m);
}

/** Memories that share words with the request, then the newest ones, up to `max`. */
function pickRelevant(memories: Memory[], intent: string, max: number): Memory[] {
  const picked = rank(memories, intent).slice(0, max);
  for (const m of memories.slice().reverse()) {
    if (picked.length >= max) break;
    if (!picked.includes(m)) picked.push(m);
  }
  return picked;
}
