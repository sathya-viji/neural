import { createServer } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { CONNECTOR_META, EFFECTS, MIN_RISK, type Effect, type Risk } from "@uab/protocol";

export { CONNECTOR_META, type Effect, type Risk };

type JsonSchema = { type: "object"; properties?: Record<string, unknown>; required?: string[]; [k: string]: unknown };

export interface ConnectorTool {
  /** snake_case, e.g. "add_note". */
  name: string;
  /** Short and human, e.g. "Add a note". Shown in Permissions. */
  title: string;
  /** What it does and when to use it. The AI reads this. */
  description: string;
  /** JSON Schema of the arguments. */
  input: JsonSchema;
  /**
   * What the tool does to the world. The kernel uses this to decide when to ask the user:
   * read · write (the user's own data) · send (to someone else) · spend (money) · delete · device.
   */
  effects: Effect[];
  /** Optional; never lower than the effects imply (spend is always high). */
  risk?: Risk;
  /** Approval-card sentence with {argument} placeholders, e.g. 'Delete the note "{title}"'. */
  summary?: string;
  run(args: Record<string, any>): Promise<string | { text: string; data?: Record<string, unknown> }>;
}

export interface ConnectorDefinition {
  name: string;
  version: string;
  tools: ConnectorTool[];
}

const ORDER: Risk[] = ["low", "medium", "high"];

/** The risk the kernel will use: the declared one, raised to what the effects imply. */
export function effectiveRisk(effects: Effect[], declared?: Risk): Risk {
  const floor = effects.map((e) => MIN_RISK[e]).reduce((a, b) => (ORDER.indexOf(b) > ORDER.indexOf(a) ? b : a), "low" as Risk);
  return declared && ORDER.indexOf(declared) >= ORDER.indexOf(floor) ? declared : floor;
}

function check(def: ConnectorDefinition): void {
  const names = new Set<string>();
  for (const t of def.tools) {
    if (!/^[a-z][a-z0-9_]{1,63}$/.test(t.name)) throw new Error(`Tool name "${t.name}" should be snake_case`);
    if (names.has(t.name)) throw new Error(`Two tools are called "${t.name}"`);
    names.add(t.name);
    if (!t.effects.length || t.effects.some((e) => !EFFECTS.includes(e))) throw new Error(`${t.name}: effects must be some of ${EFFECTS.join(", ")}`);
    for (const key of t.summary?.match(/\{([\w.]+)\}/g) ?? []) {
      const field = key.slice(1, -1).split(".")[0];
      if (!(field in (t.input.properties ?? {}))) throw new Error(`${t.name}: the summary uses {${field}}, which isn't an argument`);
    }
  }
}

/** The tool as MCP describes it: standard hints for every MCP app, plus exact labels for the kernel. */
function describe(t: ConnectorTool) {
  const readOnly = t.effects.every((e) => e === "read");
  return {
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: t.input,
    annotations: {
      title: t.title,
      readOnlyHint: readOnly,
      destructiveHint: t.effects.includes("delete"),
      openWorldHint: t.effects.some((e) => e === "send" || e === "spend"),
    },
    _meta: {
      [CONNECTOR_META.effects]: t.effects,
      [CONNECTOR_META.risk]: effectiveRisk(t.effects, t.risk),
      ...(t.summary ? { [CONNECTOR_META.summary]: t.summary } : {}),
    },
  };
}

function build(def: ConnectorDefinition): Server {
  const server = new Server({ name: def.name, version: def.version }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: def.tools.map(describe) }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = def.tools.find((t) => t.name === req.params.name);
    if (!tool) return { isError: true, content: [{ type: "text", text: `No tool called ${req.params.name}` }] };
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    const missing = (tool.input.required ?? []).filter((k) => args[k] === undefined || args[k] === null || args[k] === "");
    if (missing.length) return { isError: true, content: [{ type: "text", text: `Missing: ${missing.join(", ")}` }] };
    try {
      const out = await tool.run(args);
      const result = typeof out === "string" ? { text: out } : out;
      return { content: [{ type: "text", text: result.text }], ...(result.data ? { structuredContent: result.data } : {}) };
    } catch (err) {
      return { isError: true, content: [{ type: "text", text: (err as Error).message }] };
    }
  });
  return server;
}

/**
 * Define a connector. Each tool says what it does (effects), so the kernel
 * knows when to ask the user, and can give a sentence for the approval card.
 *
 *   const notes = defineConnector({ name: "notes", version: "1.0.0", tools: [...] });
 *   await notes.serveStdio();          // run by the app as a program on this computer
 *   await notes.serveHttp({ port });   // or as an online service at http://…/mcp
 */
export function defineConnector(def: ConnectorDefinition) {
  check(def);
  return {
    definition: def,
    /** As a program the app starts (add it under Services → Run a program on this Mac). */
    async serveStdio(): Promise<void> {
      await build(def).connect(new StdioServerTransport());
    },
    /** As an online service at http://host:port/mcp. Put it behind HTTPS (and sign-in) before sharing it. */
    async serveHttp({ port, host = "127.0.0.1" }: { port: number; host?: string }): Promise<{ url: string; close(): void }> {
      const http = createServer(async (req, res) => {
        if (!req.url?.startsWith("/mcp")) return void res.writeHead(404).end();
        if (req.method !== "POST") return void res.writeHead(405).end();
        let body = "";
        for await (const chunk of req) body += chunk;
        // Stateless: a fresh server per request is simplest and scales out.
        const server = build(def);
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        res.on("close", () => (transport.close(), server.close()));
        await server.connect(transport);
        await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
      });
      await new Promise<void>((resolve) => http.listen(port, host, resolve));
      const actual = (http.address() as { port: number }).port;
      return { url: `http://${host}:${actual}/mcp`, close: () => http.close() };
    },
  };
}
