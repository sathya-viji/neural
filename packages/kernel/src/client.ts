import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { KernelEvents, KernelMethods, RpcNotification, RpcResponse } from "@uab/protocol";

export interface KernelClientOptions {
  /** Node binary to run the kernel with. Defaults to the current one. */
  execPath?: string;
  env?: NodeJS.ProcessEnv;
  onLog?: (line: string) => void;
}

/** Starts the kernel as a separate process and talks to it. Used by hosts (desktop app, CLI). */
export class KernelClient extends EventEmitter {
  private child?: ChildProcess;
  private nextId = 1;
  private waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  constructor(private options: KernelClientOptions = {}) {
    super();
  }

  async start(): Promise<void> {
    const entry = fileURLToPath(new URL("./main.js", import.meta.url));
    const child = spawn(this.options.execPath ?? process.execPath, [entry], {
      env: { ...process.env, ...this.options.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    const ready = new Promise<void>((resolve, reject) => {
      this.once("kernel.ready", () => resolve());
      child.once("exit", (code) => reject(new Error(`Kernel exited during start (code ${code})`)));
    });

    createInterface({ input: child.stderr! }).on("line", (l) => this.options.onLog?.(l));
    createInterface({ input: child.stdout! }).on("line", (line) => {
      let msg: RpcResponse | RpcNotification;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if ("id" in msg && typeof msg.id === "number") {
        const w = this.waiting.get(msg.id);
        if (!w) return;
        this.waiting.delete(msg.id);
        if (msg.error) w.reject(new Error(msg.error.message));
        else w.resolve(msg.result);
      } else if ("method" in msg) {
        this.emit(msg.method, msg.params);
      }
    });
    child.on("exit", (code) => {
      for (const w of this.waiting.values()) w.reject(new Error(`Kernel stopped (code ${code})`));
      this.waiting.clear();
      this.emit("exit", code);
    });
    await ready;
  }

  call<M extends keyof KernelMethods>(method: M, params: KernelMethods[M]["params"]): Promise<KernelMethods[M]["result"]> {
    if (!this.child?.stdin?.writable) return Promise.reject(new Error("Kernel is not running"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.child!.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  onEvent<E extends keyof KernelEvents>(event: E, listener: (payload: KernelEvents[E]) => void): this {
    return this.on(event, listener);
  }

  stop(): void {
    this.child?.stdin?.end();
  }
}
