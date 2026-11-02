import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { existsSync, rmSync, chmodSync } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createInterface } from "node:readline";
import { agentSocketPath, type Capability, type Decision } from "@uab/protocol";
import type { Kernel } from "./kernel.js";
import { readJson, writeJson } from "./store.js";

const TOKEN = "agents.token";


/**
 * Lets other AI apps (Claude Desktop, ChatGPT, other agents) act through the
 * kernel, via the uab-mcp bridge. Off until the user turns it on. An app needs
 * the pairing key shown in Settings. Every request goes through the same
 * policy and approvals as Neural's own, and the approval card names the app.
 */
export class AgentAccess {
  private server?: Server;
  private configPath: string;
  private clients = new Set<string>();
  onChange: () => void = () => {};

  constructor(private kernel: Kernel) {
    this.configPath = join(kernel.home, "agents.json");
  }

  get enabled(): boolean {
    return readJson<{ enabled?: boolean }>(this.configPath, {}).enabled === true;
  }

  async status(): Promise<{ enabled: boolean; listening: boolean; socket: string; connected: string[] }> {
    return { enabled: this.enabled, listening: !!this.server, socket: agentSocketPath(this.kernel.home), connected: [...this.clients] };
  }

  /** The pairing key apps put in their config. Created on first use; `rotate` makes a new one (old configs stop working). */
  async token(rotate = false): Promise<string> {
    let t = rotate ? null : await this.kernel.vault.get(TOKEN);
    if (!t) {
      t = randomBytes(24).toString("base64url");
      await this.kernel.vault.set(TOKEN, t);
    }
    return t;
  }

  async setEnabled(on: boolean): Promise<void> {
    writeJson(this.configPath, { enabled: on });
    if (on) await this.start();
    else this.stop();
    this.onChange();
  }

  async start(): Promise<void> {
    if (this.server || !this.enabled) return;
    const path = agentSocketPath(this.kernel.home);
    if (existsSync(path)) rmSync(path, { force: true });
    await this.token();
    const server = createServer((socket) => void this.serve(socket));
    await new Promise<void>((resolve, reject) => server.once("error", reject).listen(path, () => resolve()));
    chmodSync(path, 0o600);
    this.server = server;
  }

  stop(): void {
    this.server?.close();
    this.server = undefined;
    rmSync(agentSocketPath(this.kernel.home), { force: true });
  }

  private async serve(socket: Socket): Promise<void> {
    const send = (msg: unknown) => socket.write(JSON.stringify(msg) + "\n");
    let client: string | null = null;
    let taskId: string | null = null;
    let actions = 0;
    const lines = createInterface({ input: socket });
    lines.on("error", () => {});
    socket.on("error", () => {});
    socket.on("close", () => {
      if (client) this.clients.delete(client), this.onChange();
      if (taskId) this.kernel.endTask(taskId, `${actions} ${actions === 1 ? "action" : "actions"} requested by ${client}.`);
    });

    for await (const line of lines) {
      let req: { id: number; method: string; params?: any };
      try {
        req = JSON.parse(line);
      } catch {
        continue;
      }
      const reply = (result: unknown) => send({ id: req.id, result });
      const fail = (message: string) => send({ id: req.id, error: message });
      try {
        if (req.method === "hello") {
          const given = Buffer.from(String(req.params?.token ?? ""));
          const expected = Buffer.from(await this.token());
          if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
            fail("Neural didn't accept this pairing key. Copy the current setup from Neural → Settings → Other AI apps.");
            socket.end();
            return;
          }
          client = String(req.params?.client || "Another AI app").slice(0, 60);
          this.clients.add(client);
          this.onChange();
          reply({ ok: true, kernel: "Unified AI Base" });
        } else if (!client) {
          fail("Say hello with the pairing key first.");
        } else if (req.method === "tools") {
          reply(this.kernel.hub.capabilities() satisfies Capability[]);
        } else if (req.method === "call") {
          taskId ??= this.kernel.startTask(`Requests from ${client}`);
          actions++;
          const decision: Decision = await this.kernel.propose({
            taskId,
            capability: String(req.params?.capability),
            args: (req.params?.args ?? {}) as Record<string, unknown>,
            source: "agent",
            model: client,
          });
          reply(decision);
        } else {
          fail(`Unknown method ${req.method}`);
        }
      } catch (err) {
        fail((err as Error).message);
      }
    }
  }
}
