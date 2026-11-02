#!/usr/bin/env node
/**
 * uab-mcp: lets an MCP app (Claude Desktop, ChatGPT, Cursor, other agents) act
 * through Neural. It's an MCP server on stdio that forwards to the running
 * Neural kernel, so every action follows your permissions, asks you in Neural
 * when needed, and lands in Activity.
 *
 * Setup: Neural → Settings → Other AI apps → turn on, then copy the config.
 * Env: NEURAL_PAIRING_KEY (required), UAB_HOME (default ~/.uab), NEURAL_CLIENT_NAME (optional).
 */
import { connect } from "node:net";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { homedir } from "node:os";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { agentSocketPath, capabilityToToolName, type Capability, type Decision } from "@uab/protocol";

const home = process.env.UAB_HOME || join(homedir(), ".uab");
const socketPath = agentSocketPath(home);
const NOT_RUNNING = "Neural isn't reachable. Open Neural and turn on Settings → Other AI apps.";

/** One connection to the kernel, opened on first use. */
let link: Promise<(method: string, params?: unknown) => Promise<any>> | null = null;
function kernel(client: string) {
  link ??= new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    const waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
    let next = 1;
    const call = (method: string, params?: unknown) =>
      new Promise<any>((res, rej) => {
        const id = next++;
        waiting.set(id, { resolve: res, reject: rej });
        socket.write(JSON.stringify({ id, method, params }) + "\n");
      });
    // Errors are handled on the socket below; the line reader would otherwise re-throw them.
    createInterface({ input: socket }).on("error", () => {}).on("line", (line) => {
      const msg = JSON.parse(line) as { id: number; result?: unknown; error?: string };
      const w = waiting.get(msg.id);
      if (!w) return;
      waiting.delete(msg.id);
      if (msg.error) w.reject(new Error(msg.error));
      else w.resolve(msg.result);
    });
    socket.on("error", () => ((link = null), reject(new Error(NOT_RUNNING))));
    socket.on("close", () => {
      link = null;
      for (const w of waiting.values()) w.reject(new Error(NOT_RUNNING));
    });
    socket.on("connect", async () => {
      try {
        await call("hello", { token: process.env.NEURAL_PAIRING_KEY ?? "", client });
        resolve(call);
      } catch (err) {
        link = null;
        reject(err);
      }
    });
  });
  return link;
}

const server = new Server({ name: "neural", version: "0.2.0" }, { capabilities: { tools: {} } });
const clientName = () => process.env.NEURAL_CLIENT_NAME || server.getClientVersion()?.name || "Another AI app";
let capabilities: Capability[] = [];

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const call = await kernel(clientName());
  capabilities = await call("tools");
  return {
    tools: capabilities.map((c) => {
      const readOnly = c.effects.every((e) => e === "read");
      return {
        name: capabilityToToolName(c.id),
        title: c.title,
        description: `${c.title}. ${c.description}${readOnly ? "" : " Neural may ask the user to approve this first."}`.slice(0, 1024),
        inputSchema: c.inputSchema?.type ? c.inputSchema : { type: "object", properties: {} },
        annotations: { title: c.title, readOnlyHint: readOnly, destructiveHint: c.effects.includes("delete"), openWorldHint: c.effects.some((e) => e === "send" || e === "spend") },
      };
    }),
  };
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const call = await kernel(clientName());
  if (!capabilities.length) capabilities = await call("tools");
  const cap = capabilities.find((c) => capabilityToToolName(c.id) === req.params.name);
  if (!cap) return { isError: true, content: [{ type: "text", text: `Neural has no tool called ${req.params.name}` }] };
  const d: Decision = await call("call", { capability: cap.id, args: req.params.arguments ?? {} });
  if (d.status === "executed") return { content: [{ type: "text", text: d.result.content }] };
  const text =
    d.status === "denied"
      ? d.by === "user"
        ? "The user declined this in Neural. Don't try again in another way; ask them what they'd like instead."
        : d.by === "policy"
          ? `Blocked by the user's permissions in Neural: ${d.reason}`
          : `Neural rejected the request: ${d.reason}`
      : `It didn't work: ${d.error}`;
  return { isError: true, content: [{ type: "text", text }] };
});

await server.connect(new StdioServerTransport());
