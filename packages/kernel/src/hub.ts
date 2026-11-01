import { join } from "node:path";
import { existsSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ActionResult, Capability, Effect, Risk, ServiceInfo } from "@uab/protocol";
import type { BuiltinCapability, ProviderContext } from "./builtin/types.js";
import { fileCapabilities } from "./builtin/files.js";
import { contactCapabilities } from "./builtin/contacts.js";
import { mailCapabilities } from "./builtin/mail.js";
import { systemCapabilities } from "./builtin/system.js";
import { appleCapabilities } from "./builtin/apple.js";
import { readJson, writeJson } from "./store.js";
import type { Vault } from "./vault.js";

/** Same shape as other MCP hosts use, so existing configs can be pasted in. */
interface ServicesConfig {
  mcpServers: Record<
    string,
    {
      command: string;
      args?: string[];
      env?: Record<string, string>;
      disabled?: boolean;
      /** Override how the kernel classifies a tool: { "tool_name": { effects, risk } } */
      classify?: Record<string, { effects: Effect[]; risk: Risk }>;
    }
  >;
}

/** On a Mac, use the real Mail/Contacts/Calendar/Reminders apps. Elsewhere, or with UAB_DEMO_SERVICES=1, use the demo ones. */
const useAppleApps = process.platform === "darwin" && !process.env.UAB_DEMO_SERVICES;

const BUILTIN_TITLES: Record<string, string> = {
  files: "Files",
  contacts: useAppleApps ? "Contacts" : "Contacts (demo)",
  mail: useAppleApps ? "Apple Mail" : "Mail (local outbox)",
  calendar: "Calendar",
  reminders: "Reminders",
  system: "This computer",
};

interface McpService {
  info: ServiceInfo;
  client?: Client;
  capabilities: (Capability & { toolName: string })[];
}

/**
 * Connects the kernel to services: built-in ones and MCP servers.
 * Only the kernel holds these connections; the intelligence layer never does.
 */
export class ServiceHub {
  private builtins = new Map<string, BuiltinCapability>();
  private mcp = new Map<string, McpService>();
  private configPath: string;

  constructor(private ctx: ProviderContext, private vault: Vault) {
    const personal = useAppleApps ? appleCapabilities : [...contactCapabilities, ...mailCapabilities];
    for (const cap of [...fileCapabilities, ...personal, ...systemCapabilities]) {
      this.builtins.set(cap.id, cap);
    }
    this.configPath = join(ctx.home, "services.json");
    if (!existsSync(this.configPath)) writeJson(this.configPath, { mcpServers: {} });
  }

  async connect(): Promise<void> {
    await this.disconnect();
    const config = readJson<ServicesConfig>(this.configPath, { mcpServers: {} });
    await Promise.all(Object.entries(config.mcpServers ?? {}).map(([id, def]) => this.connectOne(id, def)));
  }

  private async connectOne(id: string, def: ServicesConfig["mcpServers"][string]): Promise<void> {
    const service: McpService = {
      info: { id: `mcp.${id}`, title: id, kind: "mcp", status: "disabled", capabilityCount: 0 },
      capabilities: [],
    };
    this.mcp.set(id, service);
    if (def.disabled) return;
    try {
      const env = { ...getDefaultEnvironment(), ...(await this.vault.resolveRefs(def.env)) };
      const transport = new StdioClientTransport({ command: def.command, args: def.args ?? [], env, stderr: "ignore" });
      const client = new Client({ name: "unified-ai-base-kernel", version: "0.1.0" });
      await withTimeout(client.connect(transport), 30_000, `Timed out connecting to ${id}`);
      const { tools } = await client.listTools();
      service.client = client;
      service.capabilities = tools.map((t) => {
        const override = def.classify?.[t.name];
        const { effects, risk } = override ?? classifyMcpTool(t.annotations);
        return {
          id: `mcp.${id}.${t.name}`,
          service: `mcp.${id}`,
          title: t.annotations?.title ?? t.title ?? t.name,
          description: t.description ?? "",
          inputSchema: t.inputSchema as Capability["inputSchema"],
          effects,
          risk,
          toolName: t.name,
        };
      });
      service.info = { ...service.info, status: "connected", capabilityCount: service.capabilities.length };
    } catch (err) {
      service.info = { ...service.info, status: "error", error: (err as Error).message };
      process.stderr.write(`[kernel] service ${id}: ${(err as Error).message}\n`);
    }
  }

  async disconnect(): Promise<void> {
    await Promise.all([...this.mcp.values()].map((s) => s.client?.close().catch(() => {})));
    this.mcp.clear();
  }

  services(): ServiceInfo[] {
    const counts = new Map<string, number>();
    for (const c of this.builtins.values()) counts.set(c.service, (counts.get(c.service) ?? 0) + 1);
    const builtin: ServiceInfo[] = [...counts].map(([id, n]) => ({
      id,
      title: BUILTIN_TITLES[id] ?? id,
      kind: "builtin",
      status: "connected",
      capabilityCount: n,
    }));
    return [...builtin, ...[...this.mcp.values()].map((s) => s.info)];
  }

  capabilities(): Capability[] {
    const strip = ({ id, service, title, description, inputSchema, effects, risk }: Capability): Capability => ({
      id, service, title, description, inputSchema, effects, risk,
    });
    return [
      ...[...this.builtins.values()].map(strip),
      ...[...this.mcp.values()].flatMap((s) => s.capabilities.map(strip)),
    ];
  }

  get(id: string): Capability | undefined {
    return this.capabilities().find((c) => c.id === id);
  }

  async summarize(id: string, args: Record<string, unknown>): Promise<string> {
    const builtin = this.builtins.get(id);
    if (builtin?.summarize) {
      try {
        return await builtin.summarize(args);
      } catch {
        /* fall through to the generic summary */
      }
    }
    const cap = this.get(id);
    const shown = Object.entries(args)
      .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
      .join(", ");
    return `${cap?.title ?? id}${shown ? ` (${shown.length > 200 ? shown.slice(0, 200) + "…" : shown})` : ""}`;
  }

  /** Run a capability. Only the kernel calls this, after authorisation. */
  async execute(id: string, args: Record<string, unknown>): Promise<{ result: ActionResult; verified: boolean }> {
    const builtin = this.builtins.get(id);
    if (builtin) {
      const result = await builtin.run(args, this.ctx);
      const verified = builtin.verify ? await builtin.verify(args, result, this.ctx) : true;
      return { result, verified };
    }
    for (const service of this.mcp.values()) {
      const cap = service.capabilities.find((c) => c.id === id);
      if (!cap) continue;
      if (!service.client) throw new Error(`${service.info.title} is not connected`);
      const res = await service.client.callTool({ name: cap.toolName, arguments: args });
      const parts = (res.content as { type: string; text?: string }[] | undefined) ?? [];
      const content = parts.map((p) => (p.type === "text" ? p.text : `[${p.type} content]`)).join("\n");
      if (res.isError) throw new Error(content || "The service reported an error");
      return { result: { content, data: res.structuredContent }, verified: true };
    }
    throw new Error(`Unknown capability ${id}`);
  }
}

/**
 * MCP annotations are hints from the server. Unless the server says a tool
 * only reads, assume it changes things and ask the user first.
 */
function classifyMcpTool(a?: { readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean }): {
  effects: Effect[];
  risk: Risk;
} {
  if (a?.readOnlyHint) return { effects: ["read"], risk: "low" };
  if (a?.destructiveHint !== false) return { effects: ["write", "delete"], risk: "high" };
  return { effects: a?.openWorldHint === false ? ["write"] : ["write", "send"], risk: "medium" };
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(message)), ms))]);
}
