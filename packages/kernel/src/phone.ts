import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { ApprovalRequest } from "@uab/protocol";
import type { Kernel } from "./kernel.js";
import { readJson, writeJson } from "./store.js";
import { phonePage } from "./phone-page.js";

const TOKEN = "phone.token";
const DEFAULT_PORT = 47615;

/** This Mac's address on the local network (Wi-Fi or Ethernet). */
export function lanAddress(): string | null {
  for (const [name, list] of Object.entries(networkInterfaces())) {
    if (!/^(en|eth|wl)/.test(name)) continue;
    const v4 = list?.find((a) => a.family === "IPv4" && !a.internal);
    if (v4) return v4.address;
  }
  return null;
}

/**
 * Approve from your phone. The kernel serves a small page on the local network
 * that lists approvals waiting for you, written by the kernel exactly as on the
 * Mac, with Allow and Decline. Off until the user turns it on; the address
 * carries a long pairing key (shown as a QR code in Settings), and repeated
 * wrong keys block that address for a while. It only shows and resolves
 * approvals: nothing else in the kernel is reachable from it.
 */
export class PhoneApprovals {
  private server?: Server;
  private configPath: string;
  private listeners = new Set<ServerResponse>();
  private failures = new Map<string, { count: number; until: number }>();
  private lastSeen?: string;

  constructor(private kernel: Kernel) {
    this.configPath = join(kernel.home, "phone.json");
    kernel.on("approval.requested", () => this.broadcast());
    kernel.on("approval.resolved", () => this.broadcast());
  }

  private config(): { enabled?: boolean; port?: number } {
    return readJson(this.configPath, {});
  }

  get enabled(): boolean {
    return this.config().enabled === true;
  }

  async token(rotate = false): Promise<string> {
    let t = rotate ? null : await this.kernel.vault.get(TOKEN);
    if (!t) {
      t = randomBytes(24).toString("base64url");
      await this.kernel.vault.set(TOKEN, t);
      for (const res of this.listeners) res.end();
      this.listeners.clear();
    }
    return t;
  }

  async status(): Promise<{ enabled: boolean; listening: boolean; url: string | null; lastSeen: string | null }> {
    const address = lanAddress();
    const port = this.port();
    const url = this.server && address ? `http://${address}:${port}/a/${await this.token()}` : null;
    return { enabled: this.enabled, listening: !!this.server, url, lastSeen: this.lastSeen ?? null };
  }

  private port(): number {
    return (this.server?.address() as { port?: number } | null)?.port ?? this.config().port ?? DEFAULT_PORT;
  }

  async setEnabled(on: boolean): Promise<void> {
    writeJson(this.configPath, { ...this.config(), enabled: on });
    if (on) await this.start();
    else this.stop();
  }

  async start(): Promise<void> {
    if (this.server || !this.enabled) return;
    await this.token();
    const server = createServer((req, res) => void this.handle(req, res).catch(() => res.writeHead(500).end()));
    const listen = (port: number) => new Promise<void>((resolve, reject) => server.once("error", reject).listen(port, "0.0.0.0", () => resolve()));
    try {
      await listen(this.config().port ?? DEFAULT_PORT);
    } catch {
      await listen(0); // The usual port is taken: use any free one, and keep it next time.
    }
    writeJson(this.configPath, { ...this.config(), port: (server.address() as { port: number }).port });
    this.server = server;
  }

  stop(): void {
    for (const res of this.listeners) res.end();
    this.listeners.clear();
    this.server?.close();
    this.server = undefined;
  }

  private broadcast(): void {
    for (const res of this.listeners) res.write(`event: changed\ndata: ${this.kernel.pendingApprovals().length}\n\n`);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader("cache-control", "no-store");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("x-frame-options", "DENY");
    const ip = req.socket.remoteAddress ?? "?";
    const block = this.failures.get(ip);
    if (block && block.until > Date.now()) return void res.writeHead(429).end("Too many wrong attempts. Try again later.");

    const m = (req.url ?? "").match(/^\/a\/([\w-]{20,64})(\/[\w/]*)?(\?.*)?$/);
    const given = Buffer.from(m?.[1] ?? "");
    const expected = Buffer.from(await this.token());
    if (!m || given.length !== expected.length || !timingSafeEqual(given, expected)) {
      const f = this.failures.get(ip) ?? { count: 0, until: 0 };
      f.count++;
      if (f.count >= 10) (f.until = Date.now() + 10 * 60 * 1000), (f.count = 0);
      this.failures.set(ip, f);
      return void res.writeHead(404).end("Not found");
    }
    this.failures.delete(ip);
    this.lastSeen = new Date().toISOString();
    const path = m[2] ?? "/";

    if (req.method === "GET" && (path === "/" || path === "")) {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:",
      });
      return void res.end(phonePage);
    }
    if (req.method === "GET" && path === "/api/pending") {
      res.writeHead(200, { "content-type": "application/json" });
      const titles = new Map(this.kernel.hub.services().map((s) => [s.id, s.title.replace(/ \(.*\)$/, "")]));
      return void res.end(JSON.stringify(this.kernel.pendingApprovals().map((r) => forPhone(r, titles))));
    }
    if (req.method === "GET" && path === "/api/events") {
      res.writeHead(200, { "content-type": "text/event-stream", connection: "keep-alive" });
      res.write(`event: changed\ndata: ${this.kernel.pendingApprovals().length}\n\n`);
      this.listeners.add(res);
      const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
      req.on("close", () => (clearInterval(ping), this.listeners.delete(res)));
      return;
    }
    if (req.method === "POST" && path === "/api/resolve") {
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 2000) return void res.writeHead(413).end();
      }
      const { approvalId, approve } = JSON.parse(body || "{}") as { approvalId?: string; approve?: boolean };
      try {
        this.kernel.resolveApproval(String(approvalId), approve === true);
        res.writeHead(200, { "content-type": "application/json" });
        return void res.end('{"ok":true}');
      } catch (err) {
        res.writeHead(409, { "content-type": "application/json" });
        return void res.end(JSON.stringify({ error: (err as Error).message }));
      }
    }
    res.writeHead(404).end("Not found");
  }
}

/** What the phone shows: the kernel's own words, never the model's. */
function forPhone(r: ApprovalRequest, titles: Map<string, string>) {
  return {
    approvalId: r.approvalId,
    summary: r.summary,
    title: r.capability.title,
    service: titles.get(r.capability.service) ?? r.capability.service,
    risk: r.capability.risk,
    effects: r.capability.effects,
    from: r.model ?? r.source,
    args: r.args,
    createdAt: r.createdAt,
  };
}
