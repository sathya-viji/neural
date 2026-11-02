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
import { CallToolRequestSchema, ListResourcesRequestSchema, ListToolsRequestSchema, ReadResourceRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { approvalCardHtml, CARD_MIME, CARD_URI } from "./approval-card.js";
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
      const msg = JSON.parse(line) as { id: number; result?: unknown; error?: string; event?: string; approval?: InAppApproval };
      if (msg.event === "approval" && msg.approval) return void confirmInChat(msg.approval, call);
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
        // Tell Neural whether this app can show a confirmation in its own chat (MCP elicitation).
        await call("hello", { token: process.env.NEURAL_PAIRING_KEY ?? "", client, canConfirm: !!server.getClientCapabilities()?.elicitation, canShowCard: canShowCard() });
        resolve(call);
      } catch (err) {
        link = null;
        reject(err);
      }
    });
  });
  return link;
}

const server = new Server({ name: "neural", version: "0.3.1" }, { capabilities: { tools: {}, resources: {} } });
/** The app can show interactive cards in its chat (MCP Apps). */
const canShowCard = () => !!(server.getClientCapabilities() as { extensions?: Record<string, unknown> } | undefined)?.extensions?.["io.modelcontextprotocol/ui"];

server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [{ uri: CARD_URI, name: "Neural approval card", mimeType: CARD_MIME }] }));
server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
  if (req.params.uri !== CARD_URI) throw new Error("No such resource");
  return { contents: [{ uri: CARD_URI, mimeType: CARD_MIME, text: approvalCardHtml }] };
});

/** Tools only the approval card can call; the AI never sees them. */
const APP_ONLY = { ui: { visibility: ["app"] } };
const ANSWER_TOOL = {
  name: "neural_answer",
  title: "Answer a Neural approval",
  description: "Used by Neural's approval card when the user taps Allow or Decline.",
  inputSchema: { type: "object" as const, properties: { approval_id: { type: "string" }, code: { type: "string" }, approve: { type: "boolean" } }, required: ["approval_id", "code", "approve"] },
  _meta: APP_ONLY,
};
const STATUS_TOOL = {
  name: "neural_request_status",
  title: "Status of a Neural request",
  description: "Used by Neural's approval card to show the outcome after the user answers.",
  inputSchema: { type: "object" as const, properties: { request_id: { type: "string" } }, required: ["request_id"] },
  _meta: APP_ONLY,
};
// Shows up in the app's MCP log: which features the app supports.
server.oninitialized = () => console.error(`[neural] ${server.getClientVersion()?.name ?? "app"} supports: ${JSON.stringify(server.getClientCapabilities() ?? {})}`);

interface InAppApproval {
  approvalId: string;
  summary: string;
  service: string;
  risk: string;
  effects: string[];
}

const EFFECT_WORDS: Record<string, string> = { write: "changes something", send: "sends something", delete: "deletes something", device: "uses your Mac" };

/**
 * Show the kernel's approval card in the app's chat and pass back the user's
 * answer. The app draws the prompt and only the user can answer it; the same
 * card stays in Neural (Mac and phone), and whichever is answered first counts.
 */
async function confirmInChat(a: InAppApproval, call: (method: string, params?: unknown) => Promise<any>): Promise<void> {
  const what = a.effects.filter((e) => e !== "read").map((e) => EFFECT_WORDS[e] ?? e).join(", ");
  try {
    const answer = await server.elicitInput({
      message: `Neural needs your OK\n\n${a.service}: ${a.summary}\n\n${a.risk[0].toUpperCase()}${a.risk.slice(1)} risk${what ? ` · ${what}` : ""}. Allow it?`,
      requestedSchema: { type: "object", properties: {} },
    });
    if (answer.action === "accept" || answer.action === "decline") await call("resolve", { approvalId: a.approvalId, approve: answer.action === "accept" });
    // "cancel" (dismissed): leave it waiting in Neural.
  } catch {
    // The app couldn't show it, or it was already answered in Neural: nothing to do.
  }
}
const clientName = () => process.env.NEURAL_CLIENT_NAME || server.getClientVersion()?.name || "Another AI app";
let capabilities: Capability[] = [];

/** Asks about a request that was still waiting for the user's OK. Not a kernel capability: it only reads an outcome. */
const CHECK_TOOL = {
  name: "neural_check_request",
  title: "Check a waiting request",
  description:
    "Check the outcome of a Neural request that was waiting for the user's approval (you got a request id). Returns whether it's still waiting, was done, or was declined. Use this instead of repeating the action.",
  inputSchema: { type: "object" as const, properties: { request_id: { type: "string", description: "The request id Neural gave you" } }, required: ["request_id"] },
  annotations: { title: "Check a waiting request", readOnlyHint: true },
};

/** A kernel decision in words for the AI. */
function outcome(d: Decision | { status: "waiting"; requestId: string; card?: Record<string, unknown> }) {
  if (d.status === "waiting") {
    const where = d.card ? "an approval card is shown right here in the chat (and in Neural)" : "it's waiting in Neural (on the Mac, or on their phone if they've set that up)";
    return {
      content: [
        {
          type: "text" as const,
          text: `Waiting for the user's OK (request ${d.requestId}): ${where}. Nothing has happened yet; it will only happen if they allow it. Tell the user briefly. Don't retry or try another way. To find out what happened, call neural_check_request with request_id "${d.requestId}" when the user says they've answered, or a little later.`,
        },
      ],
      structuredContent: { neural: { state: "waiting", requestId: d.requestId, card: d.card } },
    };
  }
  if (d.status === "executed") return { content: [{ type: "text" as const, text: d.result.content }], structuredContent: { neural: { state: "done", text: d.result.content.slice(0, 600) } } };
  const text =
    d.status === "denied"
      ? d.by === "user"
        ? "The user declined this in Neural. Don't try again in another way; ask them what they'd like instead."
        : d.by === "policy"
          ? `Blocked by the user's permissions in Neural: ${d.reason}`
          : `Neural rejected the request: ${d.reason}`
      : `It didn't work: ${d.error}`;
  const state = d.status === "denied" ? (d.by === "user" ? "declined" : "blocked") : "failed";
  return { isError: true, content: [{ type: "text" as const, text }], structuredContent: { neural: { state, text } } };
}

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const call = await kernel(clientName());
  capabilities = await call("tools");
  return {
    tools: [CHECK_TOOL, ...(canShowCard() ? [ANSWER_TOOL, STATUS_TOOL] : []), ...capabilities.map((c) => {
      const readOnly = c.effects.every((e) => e === "read");
      return {
        name: capabilityToToolName(c.id),
        title: c.title,
        description: `${c.title}. ${c.description}${readOnly ? "" : " Neural may ask the user to approve this first; if they haven't answered within about 40 seconds you get a request id to check later with neural_check_request."}`.slice(0, 1024),
        inputSchema: c.inputSchema?.type ? c.inputSchema : { type: "object", properties: {} },
        annotations: { title: c.title, readOnlyHint: readOnly, destructiveHint: c.effects.includes("delete"), openWorldHint: c.effects.some((e) => e === "send" || e === "spend") },
        // Actions that may need approval show Neural's card in the chat.
        ...(!readOnly && canShowCard() ? { _meta: { ui: { resourceUri: CARD_URI } } } : {}),
      };
    })],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  // Problems come back as a tool result the AI can read and explain, not as a protocol error.
  try {
    return await callTool(req.params.name, req.params.arguments ?? {});
  } catch (err) {
    return { isError: true, content: [{ type: "text" as const, text: (err as Error).message }] };
  }
});

async function callTool(name: string, args: Record<string, unknown>) {
  const call = await kernel(clientName());
  if (name === CHECK_TOOL.name || name === STATUS_TOOL.name) return outcome(await call("check", { requestId: String(args.request_id ?? "") }));
  if (name === ANSWER_TOOL.name) {
    await call("resolve", { approvalId: String(args.approval_id ?? ""), code: String(args.code ?? ""), approve: args.approve === true });
    return { content: [{ type: "text" as const, text: args.approve === true ? "Allowed." : "Declined." }] };
  }
  if (!capabilities.length) capabilities = await call("tools");
  const cap = capabilities.find((c) => capabilityToToolName(c.id) === name);
  if (!cap) return { isError: true, content: [{ type: "text", text: `Neural has no tool called ${name}` }] };
  // Answer before the app's tool timeout (about a minute); a waiting approval gets a request id instead.
  return outcome(await call("call", { capability: cap.id, args: args, waitMs: Number(process.env.NEURAL_WAIT_MS) || (canShowCard() ? 2_500 : 40_000) }));
}

await server.connect(new StdioServerTransport());
