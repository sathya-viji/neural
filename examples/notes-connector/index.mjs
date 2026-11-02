#!/usr/bin/env node
// A complete connector in one file: notes kept in a JSON file.
//
//   node index.mjs                 run as a program (Neural starts it)
//   node index.mjs --http 4100     run as an online service at http://127.0.0.1:4100/mcp
//
// Each tool says what it does (effects), so Neural's kernel lets reading happen
// straight away and asks the user before adding or deleting, with a clear sentence.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { defineConnector } from "@uab/connector-kit";

const FILE = process.env.NOTES_FILE || join(homedir(), ".notes-connector.json");
const load = () => (existsSync(FILE) ? JSON.parse(readFileSync(FILE, "utf8")) : []);
const save = (notes) => writeFileSync(FILE, JSON.stringify(notes, null, 2));

const notes = defineConnector({
  name: "notes",
  version: "1.0.0",
  tools: [
    {
      name: "list_notes",
      title: "List notes",
      description: "List the user's notes, newest first. Optionally only those containing some words.",
      input: { type: "object", properties: { search: { type: "string", description: "Words to look for" } } },
      effects: ["read"],
      async run({ search }) {
        const found = load().filter((n) => !search || `${n.title} ${n.text}`.toLowerCase().includes(String(search).toLowerCase()));
        if (!found.length) return "No notes.";
        return { text: found.map((n) => `${n.id}: ${n.title} — ${n.text}`).join("\n"), data: { notes: found } };
      },
    },
    {
      name: "add_note",
      title: "Add a note",
      description: "Save a new note with a short title and the text.",
      input: { type: "object", properties: { title: { type: "string" }, text: { type: "string" } }, required: ["title", "text"] },
      effects: ["write"],
      summary: 'Add a note "{title}": {text}',
      async run({ title, text }) {
        const note = { id: randomUUID().slice(0, 8), title, text, created: new Date().toISOString() };
        save([note, ...load()]);
        return { text: `Saved "${title}" (${note.id}).`, data: note };
      },
    },
    {
      name: "delete_note",
      title: "Delete a note",
      description: "Delete one note by its id (from list_notes).",
      input: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      effects: ["delete"],
      summary: "Delete note {id}",
      async run({ id }) {
        const all = load();
        const gone = all.find((n) => n.id === id);
        if (!gone) throw new Error(`No note ${id}`);
        save(all.filter((n) => n.id !== id));
        return `Deleted "${gone.title}".`;
      },
    },
  ],
});

const http = process.argv.indexOf("--http");
if (http > 0) {
  const { url } = await notes.serveHttp({ port: Number(process.argv[http + 1]) || 4100 });
  console.error(`Notes connector at ${url}`);
} else {
  await notes.serveStdio();
}
