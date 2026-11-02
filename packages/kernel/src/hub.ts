import { join } from "node:path";
import { existsSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpSignIn } from "./mcp-signin.js";
import { CONNECTOR_META, EFFECTS, MIN_RISK, type ActionResult, type Capability, type Effect, type Risk, type ServiceInfo } from "@uab/protocol";
import type { BuiltinCapability, ProviderContext } from "./builtin/types.js";
import { fileCapabilities } from "./builtin/files.js";
import { contactCapabilities } from "./builtin/contacts.js";
import { mailCapabilities } from "./builtin/mail.js";
import { systemCapabilities } from "./builtin/system.js";
import { appleCapabilities } from "./builtin/apple.js";
import { gmail, gmailCapabilities } from "./builtin/gmail.js";
import { webCapabilities } from "./builtin/web.js";
import { memoryCapabilities } from "./builtin/memory.js";
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
      /** The name shown to the user, e.g. "Zomato". */
      title?: string;
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
  memory: "Memory",
  system: "This computer",
};

interface McpService {
  info: ServiceInfo;
  client?: Client;
  signIn?: McpSignIn;
  url?: string;
  capabilities: (Capability & { toolName: string; summaryTemplate?: string })[];
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
    for (const cap of [...fileCapabilities, ...personal, ...gmailCapabilities, ...webCapabilities, ...memoryCapabilities, ...systemCapabilities]) {
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
      info: { id: `mcp.${id}`, title: def.title || friendlyServiceName(id), kind: "mcp", status: "disabled", capabilityCount: 0 },
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
        // Your own setting wins; then what the connector declares; then MCP's hints.
        const override = def.classify?.[t.name];
        const declared = declaredLabels(t._meta);
        const { effects, risk } = override ?? declared ?? classifyMcpTool(t.annotations);
        const template = t._meta?.[CONNECTOR_META.summary];
        return {
          id: `mcp.${id}.${t.name}`,
          service: `mcp.${id}`,
          title: t.annotations?.title ?? t.title ?? humanize(t.name),
          description: t.description ?? "",
          inputSchema: t.inputSchema as Capability["inputSchema"],
          effects,
          risk,
          toolName: t.name,
          summaryTemplate: typeof template === "string" ? template.slice(0, 200) : undefined,
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

  /** What is kept in the vault for services, in words: sign-ins and secrets referenced as "vault:NAME". */
  vaultEntries(): { name: string; label: string; service?: string }[] {
    const config = readJson<ServicesConfig>(this.configPath, { mcpServers: {} });
    return Object.entries(config.mcpServers ?? {}).flatMap(([id, def]) => {
      const title = def.title || friendlyServiceName(id);
      return [
        ...(def.url ? [{ name: `service.${id}.signin`, label: `${title} sign-in`, service: `mcp.${id}` }] : []),
        ...Object.values(def.env ?? {})
          .filter((v) => v.startsWith("vault:"))
          .map((v) => ({ name: v.slice(6), label: `Secret used by ${title}` })),
      ];
    });
  }

  /** Add a service to services.json. The file watcher connects it. */
  addService(input: { name: string; url?: string; command?: string }): { id: string } {
    const title = input.name.trim();
    const id = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    if (!id) throw new Error("Give the service a name.");
    if (this.builtins.size && [...this.builtins.values()].some((c) => c.service === id)) throw new Error(`"${title}" is the name of a built-in service. Pick another name.`);
    const config = readJson<ServicesConfig>(this.configPath, { mcpServers: {} });
    config.mcpServers ??= {};
    if (config.mcpServers[id]) throw new Error(`There's already a service called "${title}".`);
    if (input.url?.trim()) {
      let url: URL;
      try {
        url = new URL(input.url.trim());
      } catch {
        throw new Error("That address doesn't look right. It should start with https://");
      }
      if (url.protocol !== "https:" && !/^(127\.0\.0\.1|localhost|\[::1\])$/.test(url.hostname)) throw new Error("Online services must use https://");
      config.mcpServers[id] = { title, url: url.toString() };
    } else if (input.command?.trim()) {
      const parts = input.command.trim().match(/"[^"]*"|\S+/g)!.map((p) => p.replace(/^"|"$/g, ""));
      config.mcpServers[id] = { title, command: parts[0], args: parts.slice(1) };
    } else {
      throw new Error("Add the service's address (or a command to run).");
    }
    writeJson(this.configPath, config);
    return { id: `mcp.${id}` };
  }

  /** Remove a service from services.json and forget its sign-in. */
  async removeService(serviceId: string): Promise<void> {
    const id = serviceId.replace(/^mcp\./, "");
    const config = readJson<ServicesConfig>(this.configPath, { mcpServers: {} });
    if (!config.mcpServers?.[id]) throw new Error(`No service called ${id}`);
    const service = this.mcp.get(id);
    this.pendingSignIn.get(id)?.();
    await service?.client?.close().catch(() => {});
    await service?.signIn?.signOut();
    this.mcp.delete(id);
    delete config.mcpServers[id];
    writeJson(this.configPath, config);
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
        return await builtin.summarize(args, this.ctx);
      } catch {
        /* fall through to the generic summary */
      }
    }
    const cap = this.get(id);
    const service = this.services().find((x) => x.id === cap?.service);
    // A connector's card template, filled by the kernel from the real arguments.
    const template = [...this.mcp.values()].flatMap((s) => s.capabilities).find((c) => c.id === id)?.summaryTemplate;
    if (template && service) return `${service.title}: ${fillTemplate(template, args)}`;
    const shown = describeArgs(args);
    const title = cap?.title ?? id;
    return `${service && cap?.service.startsWith("mcp.") ? `${service.title}: ` : ""}${title}${shown ? ` — ${shown}` : ""}`;
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
/**
 * What a connector says a tool does (see CONNECTOR_META). Unknown effects are
 * ignored, and the risk is never lower than the effects imply: a connector can't
 * label sending or paying as low risk.
 */
export function declaredLabels(meta: Record<string, unknown> | undefined): { effects: Effect[]; risk: Risk } | null {
  const raw = meta?.[CONNECTOR_META.effects];
  if (!Array.isArray(raw)) return null;
  const effects = [...new Set(raw.filter((e): e is Effect => EFFECTS.includes(e as Effect)))];
  if (!effects.length) return null;
  const order: Risk[] = ["low", "medium", "high"];
  const declaredRisk = order.includes(meta?.[CONNECTOR_META.risk] as Risk) ? (meta![CONNECTOR_META.risk] as Risk) : "low";
  const floor = effects.map((e) => MIN_RISK[e]).reduce((a, b) => (order.indexOf(b) > order.indexOf(a) ? b : a), "low" as Risk);
  return { effects, risk: order.indexOf(declaredRisk) >= order.indexOf(floor) ? declaredRisk : floor };
}

/** "Order {qty} × {item}" with the real arguments. Missing values show as "?". */
export function fillTemplate(template: string, args: Record<string, unknown>): string {
  const show = (v: unknown): string => {
    if (v === undefined || v === null || v === "") return "?";
    if (Array.isArray(v)) return v.every((x) => typeof x !== "object") ? v.join(", ") : `${v.length} ${v.length === 1 ? "item" : "items"}`;
    if (typeof v === "object") return describeArgs(v as Record<string, unknown>) || "?";
    return String(v).slice(0, 120);
  };
  return template.replace(/\{([\w.]+)\}/g, (_, key: string) => show(key.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], args))).slice(0, 300);
}

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

/** "get_restaurants_for_keyword" → "Get restaurants for keyword". */
export function humanize(name: string): string {
  const words = name.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_\-.]+/g, " ").trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function friendlyServiceName(id: string): string {
  return id.split(/[-_]/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

/** Arguments in words for an approval card: no empty values, lists counted, long text cut. */
export function describeArgs(args: Record<string, unknown>): string {
  const value = (v: unknown): string | null => {
    if (v === null || v === undefined || v === "") return null;
    if (Array.isArray(v)) {
      if (!v.length) return null;
      if (v.every((x) => typeof x !== "object")) return v.join(", ");
      return `${v.length} ${v.length === 1 ? "item" : "items"}`;
    }
    if (typeof v === "object") {
      const inner = describeArgs(v as Record<string, unknown>);
      return inner ? `(${inner})` : null;
    }
    if (typeof v === "string" && /^[a-z]+(_[a-z]+)+$/.test(v)) return v.replace(/_/g, " ");
    const s = String(v);
    return s.length > 80 ? s.slice(0, 80) + "…" : s;
  };
  const parts = Object.entries(args ?? {})
    .map(([k, v]) => {
      const shown = value(v);
      return shown === null ? null : `${humanize(k).toLowerCase()}: ${shown}`;
    })
    .filter(Boolean);
  const text = parts.join(", ");
  return text.length > 300 ? text.slice(0, 300) + "…" : text;
}
