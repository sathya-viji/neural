import { join } from "node:path";
import { existsSync } from "node:fs";
import { readJson, writeJson } from "../store.js";
import type { BuiltinCapability } from "./types.js";
import { str } from "./types.js";

interface Contact {
  name: string;
  email?: string;
  phone?: string;
  notes?: string;
}

const SAMPLE: Contact[] = [
  { name: "Sam Rivera", email: "sam.rivera@example.com", notes: "Colleague, finance team" },
  { name: "Priya Nair", email: "priya.nair@example.com", notes: "Manager" },
];

function load(home: string): Contact[] {
  const path = join(home, "contacts.json");
  if (!existsSync(path)) writeJson(path, SAMPLE);
  return readJson<Contact[]>(path, []);
}

export const contactCapabilities: BuiltinCapability[] = [
  {
    id: "contacts.find",
    service: "contacts",
    title: "Find a contact",
    description: "Look up people in the user's contacts by name. Returns email addresses and notes.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "Full or partial name" } },
      required: ["name"],
    },
    effects: ["read"],
    risk: "low",
    summarize: (a) => `Look up "${a.name}" in your contacts`,
    async run(args, ctx) {
      const q = str(args, "name").toLowerCase();
      const matches = load(ctx.home).filter((c) => c.name.toLowerCase().includes(q));
      if (!matches.length) return { content: `No contact matching "${args.name}".`, data: [] };
      return {
        content: matches.map((c) => [c.name, c.email, c.phone, c.notes].filter(Boolean).join(" · ")).join("\n"),
        data: matches,
      };
    },
  },
];
