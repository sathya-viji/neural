import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { existsSync, rmSync, chmodSync } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createInterface } from "node:readline";
import { agentSocketPath, type ApprovalRequest, type Capability, type Decision } from "@uab/protocol";
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
  /** Requests still waiting for the user's OK after the app stopped waiting, by request id. */
  private waiting = new Map<string, { client: string; decision?: Decision; createdAt: number }>();
  /** One-time codes for approval cards shown inside an app's chat; the AI never gets them. */
  private cardCodes = new Map<string, string>();
  onChange: () => void = () => {};

  constructor(private kernel: Kernel) {
    this.configPath = join(kernel.home, "agents.json");
  }

  private config(): { enabled?: boolean; confirmInApp?: boolean } {
    return readJson(this.configPath, {});
  }

  get enabled(): boolean {
    return this.config().enabled === true;
  }

  /**
   * Whether an app may show the kernel's approval card in its own chat (MCP
   * elicitation) and pass back the user's answer. The app draws the prompt, not
   * the model, but Neural can't see it, so it's the user's choice; anything that
   * spends money is always approved in Neural itself.
   */
  get confirmInApp(): boolean {
    return this.config().confirmInApp === true;
  }

  setConfirmInApp(on: boolean): void {
    writeJson(this.configPath, { ...this.config(), confirmInApp: on });
    this.onChange();
  }

  async status(): Promise<{ enabled: boolean; listening: boolean; socket: string; connected: string[]; confirmInApp: boolean }> {
    return { enabled: this.enabled, listening: !!this.server, socket: agentSocketPath(this.kernel.home), connected: [...this.clients], confirmInApp: this.confirmInApp };
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
    writeJson(this.configPath, { ...this.config(), enabled: on });
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
    let canConfirm = false; // the app can show a confirmation prompt (MCP elicitation)
    let canShowCard = false; // the app can show an interactive card in its chat (MCP Apps)
    // Offer this connection's approvals to the app, to show in its chat (see confirmInApp).
    const inAppAllowed = (r: ApprovalRequest) => canConfirm && this.confirmInApp && r.taskId === taskId && !r.capability.effects.includes("spend");
    const cardAllowed = (r: ApprovalRequest) => canShowCard && this.confirmInApp && r.taskId === taskId && !r.capability.effects.includes("spend");
    const serviceTitle = (r: ApprovalRequest) => this.kernel.hub.services().find((x) => x.id === r.capability.service)?.title.replace(/ \(.*\)$/, "") ?? r.capability.service;
    const onApproval = (r: ApprovalRequest) => {
      if (!inAppAllowed(r)) return;
      send({ event: "approval", approval: { approvalId: r.approvalId, summary: r.summary, service: serviceTitle(r), risk: r.capability.risk, effects: r.capability.effects } });
    };
    this.kernel.on("approval.requested", onApproval);
    const lines = createInterface({ input: socket });
    lines.on("error", () => {});
    socket.on("error", () => {});
    socket.on("close", () => {
      this.kernel.off("approval.requested", onApproval);
      if (client) this.clients.delete(client), this.onChange();
      if (taskId) this.kernel.endTask(taskId, `${actions} ${actions === 1 ? "action" : "actions"} requested by ${client}.`);
    });

    // Each request is handled on its own, so one waiting for approval doesn't hold up the others.
    const handle = async (line: string) => {
      let req: { id: number; method: string; params?: any };
      try {
        req = JSON.parse(line);
      } catch {
        return;
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
          canConfirm = req.params?.canConfirm === true;
          canShowCard = req.params?.canShowCard === true;
          hello = true;
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
          // Note the approval this call raises, so a card for it can go back to the app.
          let raised: ApprovalRequest | undefined;
          const noteApproval = (r: ApprovalRequest) => void (r.taskId === taskId && !raised && (raised = r));
          this.kernel.on("approval.requested", noteApproval);
          const decided = this.kernel.propose({
            taskId,
            capability: String(req.params?.capability),
            args: (req.params?.args ?? {}) as Record<string, unknown>,
            source: "agent",
            model: client,
          });
          // Apps give up on a tool after about a minute, but the user may take longer to answer.
          // After waitMs, hand back a request id; the action still happens only if the user allows it.
          const waitMs = Math.min(Math.max(Number(req.params?.waitMs) || 40_000, 1_000), 120_000);
          const first = await Promise.race([decided, new Promise<null>((r) => setTimeout(() => r(null), waitMs))]);
          this.kernel.off("approval.requested", noteApproval);
          if (first) return reply(first);
          // Still running but not waiting for the user (a slow search, say): just finish it.
          if (!raised || !this.kernel.pendingApprovals().some((a) => a.approvalId === raised!.approvalId)) return reply(await decided);
          const requestId = randomBytes(6).toString("base64url");
          const entry: { client: string; decision?: Decision; createdAt: number } = { client: client!, createdAt: Date.now() };
          this.waiting.set(requestId, entry);
          void decided.then((d) => (entry.decision = d));
          for (const [id, w] of this.waiting) if (Date.now() - w.createdAt > 24 * 3600 * 1000) this.waiting.delete(id);
          // The card to show in the app's chat, with a one-time code only the card gets.
          let card: Record<string, unknown> | undefined;
          if (raised && cardAllowed(raised) && this.kernel.pendingApprovals().some((a) => a.approvalId === raised!.approvalId)) {
            const code = randomBytes(12).toString("base64url");
            this.cardCodes.set(raised.approvalId, code);
            card = { approvalId: raised.approvalId, code, summary: raised.summary, service: serviceTitle(raised), risk: raised.capability.risk, effects: raised.capability.effects };
          }
          reply({ status: "waiting", requestId, card });
        } else if (req.method === "resolve") {
          // The user answered the card in the app's own chat.
          const r = this.kernel.pendingApprovals().find((a) => a.approvalId === req.params?.approvalId);
          if (!r) return fail("That approval is no longer waiting.");
          // Answered on the card in the chat: needs the card's one-time code. Answered in a prompt: needs elicitation.
          const code = this.cardCodes.get(r.approvalId);
          const viaCard = !!req.params?.code && !!code && Buffer.byteLength(String(req.params.code)) === Buffer.byteLength(code) && timingSafeEqual(Buffer.from(String(req.params.code)), Buffer.from(code));
          if (!(viaCard ? cardAllowed(r) : inAppAllowed(r))) return fail("This app can't answer that approval; it has to be answered in Neural.");
          this.cardCodes.delete(r.approvalId);
          this.kernel.resolveApproval(r.approvalId, req.params?.approve === true);
          reply({ ok: true });
        } else if (req.method === "check") {
          const w = this.waiting.get(String(req.params?.requestId));
          if (!w || w.client !== client) return fail("No request with that id.");
          reply(w.decision ?? { status: "waiting", requestId: req.params.requestId });
        } else {
          fail(`Unknown method ${req.method}`);
        }
      } catch (err) {
        fail((err as Error).message);
      }
    };
    let hello = false;
    for await (const line of lines) {
      // Hello must finish before anything else is handled; after that, requests run side by side.
      if (!hello) await handle(line);
      else void handle(line);
    }
  }
}
