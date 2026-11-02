import { join } from "node:path";
import { mkdirSync, readdirSync, rmSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { Conversation, ConversationSummary, ConversationTurn } from "@uab/protocol";
import { readJson, writeJson } from "./store.js";

const MAX_TURNS = 200;

/**
 * Past conversations, one file each in ~/.uab/conversations. Kept on this
 * computer so a conversation can be reopened and continued after a restart.
 */
export class ConversationStore {
  private dir: string;

  constructor(home: string) {
    this.dir = join(home, "conversations");
    mkdirSync(this.dir, { recursive: true });
  }

  private file(id: string): string {
    if (!/^[a-z0-9-]{8,64}$/.test(id)) throw new Error("Unknown conversation");
    return join(this.dir, `${id}.json`);
  }

  list(limit = 50): ConversationSummary[] {
    return readdirSync(this.dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => readJson<Conversation | null>(join(this.dir, f), null))
      .filter((c): c is Conversation => !!c?.id)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit)
      .map(({ id, title, createdAt, updatedAt, turns }) => ({ id, title, createdAt, updatedAt, turnCount: turns.length }));
  }

  get(id: string): Conversation {
    const c = readJson<Conversation | null>(this.file(id), null);
    if (!c) throw new Error("That conversation no longer exists.");
    return c;
  }

  /** Add a finished turn. Starts a new conversation when there's no id yet. */
  appendTurn(id: string | undefined, turn: ConversationTurn, history: unknown[]): { id: string } {
    const now = new Date().toISOString();
    const existing = id && existsSync(this.file(id)) ? this.get(id) : null;
    const c: Conversation = existing ?? {
      id: randomUUID(),
      title: turn.question.replace(/\s+/g, " ").trim().slice(0, 60) || "Conversation",
      createdAt: now,
      updatedAt: now,
      turns: [],
      history: [],
    };
    c.turns = [...c.turns, turn].slice(-MAX_TURNS);
    c.history = history.slice(-20);
    c.updatedAt = now;
    writeJson(this.file(c.id), c);
    return { id: c.id };
  }

  delete(id: string): void {
    rmSync(this.file(id), { force: true });
  }
}
