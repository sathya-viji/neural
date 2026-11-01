import type { KernelCaller } from "../gateway.js";

/** A fetch() for cloud model APIs that goes through the kernel, which adds the API key. */
export type ModelFetch = (url: string, init: { method?: string; body?: string; headers?: Record<string, string>; signal?: AbortSignal }) => Promise<Response>;

export function kernelFetch(kernel: KernelCaller, auth: "bearer" | "x-api-key", timeoutMs = 60_000): ModelFetch {
  return async (url, init) => {
    init.signal?.throwIfAborted();
    const call = kernel.call("model.fetch", { url, method: init.method, body: init.body, headers: init.headers, auth, timeoutMs }) as Promise<{ status: number; text: string }>;
    const aborted = new Promise<never>((_, reject) => init.signal?.addEventListener("abort", () => reject(init.signal!.reason ?? new Error("Aborted")), { once: true }));
    const { status, text } = await Promise.race([call, aborted]);
    return new Response(status === 204 ? null : text, { status, headers: { "content-type": "application/json" } });
  };
}
