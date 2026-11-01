import { join } from "node:path";
import { existsSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpSignIn } from "./mcp-signin.js";
import type { ActionResult, Capability, Effect, Risk, ServiceInfo } from "@uab/protocol";
import type { BuiltinCapability, ProviderContext } from "./builtin/types.js";
import { fileCapabilities } from "./builtin/files.js";
import { contactCapabilities } from "./builtin/contacts.js";
import { mailCapabilities } from "./builtin/mail.js";
import { systemCapabilities } from "./builtin/system.js";
import { appleCapabilities } from "./builtin/apple.js";
import { gmail, gmailCapabilities } from "./builtin/gmail.js";
import { webCapabilities } from "./builtin/web.js";
import { readJson, writeJson } from "./store.js";
import type { Vault } from "./vault.js";

/** Same shape as other MCP hosts use, so existing configs can be pasted in. */
interface ServicesConfig {
  mcpServers: Record<
    string,
    {
      /** A program on this computer… */
      command?: string;
      args?: string[];
      /** …or an online service. If it needs sign-in, the user signs in from Services. */
      url?: string;
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
  gmail: "Gmail",
  web: "Web & weather",
  browser: "Built-in browser",
  system: "This computer",
};

interface McpService {
  info: ServiceInfo;
  client?: Client;
  signIn?: McpSignIn;
  url?: string;
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
  private pendingSignIn = new Map<string, () => void>();
  onChange: () => void = () => {};

  constructor(private ctx: ProviderContext, private vault: Vault) {
    this.ctx = { ...ctx, vault };
    const personal = useAppleApps ? appleCapabilities : [...contactCapabilities, ...mailCapabilities];
    for (const cap of [...fileCapabilities, ...personal, ...gmailCapabilities, ...webCapabilities, ...systemCapabilities]) {
      this.builtins.set(cap.id, cap);
    }
    this.configPath = join(ctx.home, "services.json");
    if (!existsSync(this.configPath)) writeJson(this.configPath, { mcpServers: {} });
  }

  async connect(): Promise<void> {
    await gmail.init(this.vault);
    await this.disconnect();
    const config = readJson<ServicesConfig>(this.configPath, { mcpServers: {} });
    await Promise.all(Object.entries(config.mcpServers ?? {}).map(([id, def]) => this.connectOne(id, def)));
  }

  private async connectOne(id: string, def: ServicesConfig["mcpServers"][string]): Promise<void> {
    const service: McpService = {
      info: { id: `mcp.${id}`, title: id, kind: "mcp", status: "disabled", capabilityCount: 0 },
      capabilities: [],
      url: def.url,
    };
    this.mcp.set(id, service);
    if (def.disabled) return;
    try {
      let transport;
      if (def.url) {
        service.signIn = await new McpSignIn(id, this.vault).load();
        service.info.online = true;
        service.info.signedIn = service.signIn.signedIn;
        if (!service.signIn.signedIn) {
          // Try without signing in first: some online services are open to everyone.
          const open = await tryWithoutSignIn(def.url);
          if (!open) {
            service.info.status = "signin";
            return;
          }
        }
        transport = new StreamableHTTPClientTransport(new URL(def.url), { authProvider: service.signIn });
      } else if (def.command) {
        const env = { ...getDefaultEnvironment(), ...(await this.vault.resolveRefs(def.env)) };
        transport = new StdioClientTransport({ command: def.command, args: def.args ?? [], env, stderr: "ignore" });
      } else {
        throw new Error('Add a "command" or a "url" for this service in services.json');
      }
      const client = new Client({ name: "unified-ai-base-kernel", version: "0.1.0" });
      try {
        await withTimeout(client.connect(transport), 30_000, `Timed out connecting to ${id}`);
      } catch (err) {
        if (service.signIn && /unauthori[sz]ed/i.test(`${(err as Error).name} ${(err as Error).message}`)) {
          client.close().catch(() => {});
          service.info = { ...service.info, status: "signin", signedIn: false };
          return;
        }
        throw err;
      }
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
      service.info = { ...service.info, status: "connected", signedIn: service.signIn ? true : undefined, capabilityCount: service.capabilities.length };
    } catch (err) {
      service.info = { ...service.info, status: "error", error: (err as Error).message };
      process.stderr.write(`[kernel] service ${id}: ${(err as Error).message}\n`);
    }
  }

  private online(serviceId: string): [string, McpService] {
    const id = serviceId.replace(/^mcp\./, "");
    const service = this.mcp.get(id);
    if (!service?.signIn || !service.url) throw new Error(`${id} isn't an online service`);
    return [id, service];
  }

  /** Start signing in to an online service. Returns the service's sign-in page; finishes in the background. */
  async signIn(serviceId: string): Promise<{ url: string }> {
    const [id, service] = this.online(serviceId);
    this.pendingSignIn.get(id)?.();
    const { url, cancel } = await service.signIn!.start(service.url!, async (error) => {
      this.pendingSignIn.delete(id);
      const config = readJson<ServicesConfig>(this.configPath, { mcpServers: {} });
      const def = config.mcpServers?.[id];
      await this.mcp.get(id)?.client?.close().catch(() => {});
      if (def) await this.connectOne(id, def);
      const now = this.mcp.get(id);
      if (error && now && now.info.status !== "connected") now.info.error = error;
      this.onChange();
    });
    this.pendingSignIn.set(id, cancel);
    service.info = { ...service.info, signingIn: true };
    this.onChange();
    return { url };
  }

  async signOut(serviceId: string): Promise<void> {
    const [id, service] = this.online(serviceId);
    this.pendingSignIn.get(id)?.();
    await service.client?.close().catch(() => {});
    await service.signIn!.signOut();
    service.client = undefined;
    service.capabilities = [];
    service.info = { ...service.info, status: "signin", signedIn: false, signingIn: undefined, error: undefined, capabilityCount: 0 };
    this.onChange();
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
      title: id === "gmail" && gmail.connected ? `Gmail (${gmail.status().email})` : (BUILTIN_TITLES[id] ?? id),
      kind: "builtin",
      status: id === "gmail" && !gmail.connected ? "disabled" : "connected",
      capabilityCount: n,
    }));
    return [...builtin, ...[...this.mcp.values()].map((s) => s.info)];
  }

  capabilities(): Capability[] {
    const strip = ({ id, service, title, description, inputSchema, effects, risk }: Capability): Capability => ({
      id, service, title, description, inputSchema, effects, risk,
    });
    return [
      ...[...this.builtins.values()].filter((c) => c.available?.() ?? true).map(strip),
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
      if (builtin.available && !builtin.available()) throw new Error(`${BUILTIN_TITLES[builtin.service] ?? builtin.service} isn't connected`);
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

/** Does this online service answer without a sign-in? */
async function tryWithoutSignIn(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "unified-ai-base-kernel", version: "0.1.0" } } }),
      signal: AbortSignal.timeout(15_000),
    });
    await res.body?.cancel();
    return res.status !== 401 && res.status !== 403;
  } catch {
    return true; // Let the real connection report the problem.
  }
}
