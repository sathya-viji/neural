import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as ort from "onnxruntime-web";
import { Tokenizer } from "@huggingface/tokenizers";

/** The bundled model: packages/kernel/models/all-MiniLM-L6-v2 (fetched at build time, never at runtime). */
export const MODEL_DIR = process.env.UAB_EMBED_MODEL ?? join(dirname(fileURLToPath(import.meta.url)), "..", "models", "all-MiniLM-L6-v2");
const MAX_TOKENS = 128;

/**
 * Turns short texts into meaning vectors on this computer, so the kernel can tell
 * which memories relate to a request even when they share no words
 * ("book dinner" ↔ "Vegetarian"). Runs in WebAssembly: the same on every OS.
 */
export class Embedder {
  private ready?: Promise<{ session: ort.InferenceSession; tokenizer: Tokenizer }>;
  private cache = new Map<string, Float32Array>();

  get available(): boolean {
    return existsSync(join(MODEL_DIR, "onnx", "model_quantized.onnx"));
  }

  private load() {
    this.ready ??= (async () => {
      const require = createRequire(import.meta.url);
      ort.env.wasm.numThreads = 1;
      // The WebAssembly runtime: from node_modules in development, or where the packaged app put it.
      ort.env.wasm.wasmPaths = process.env.UAB_ORT_WASM || dirname(require.resolve("onnxruntime-web")) + "/";
      ort.env.logLevel = "error";
      const tokenizer = new Tokenizer(
        JSON.parse(readFileSync(join(MODEL_DIR, "tokenizer.json"), "utf8")),
        JSON.parse(readFileSync(join(MODEL_DIR, "tokenizer_config.json"), "utf8")),
      );
      const session = await ort.InferenceSession.create(readFileSync(join(MODEL_DIR, "onnx", "model_quantized.onnx")), { executionProviders: ["wasm"] });
      return { session, tokenizer };
    })();
    return this.ready;
  }

  /** A unit-length vector for the text (mean of token vectors). */
  async embed(text: string): Promise<Float32Array> {
    const key = text.trim().toLowerCase();
    const hit = this.cache.get(key);
    if (hit) return hit;
    const { session, tokenizer } = await this.load();
    const enc = tokenizer.encode(key);
    const n = Math.min(enc.ids.length, MAX_TOKENS);
    const tensor = (values: number[]) => new ort.Tensor("int64", BigInt64Array.from(values.slice(0, n).map(BigInt)), [1, n]);
    const feeds: Record<string, ort.Tensor> = { input_ids: tensor(enc.ids), attention_mask: tensor(enc.attention_mask) };
    if (session.inputNames.includes("token_type_ids")) feeds.token_type_ids = tensor(enc.token_type_ids ?? new Array(n).fill(0));
    const out = (await session.run(feeds))[session.outputNames[0]];
    const [, tokens, dim] = out.dims as number[];
    const data = out.data as Float32Array;
    const vec = new Float32Array(dim);
    for (let t = 0; t < tokens; t++) for (let d = 0; d < dim; d++) vec[d] += data[t * dim + d] / tokens;
    const norm = Math.hypot(...vec) || 1;
    for (let d = 0; d < dim; d++) vec[d] /= norm;
    if (this.cache.size > 2000) this.cache.clear();
    this.cache.set(key, vec);
    return vec;
  }

  async similarity(a: string, b: string): Promise<number> {
    const [x, y] = await Promise.all([this.embed(a), this.embed(b)]);
    let s = 0;
    for (let i = 0; i < x.length; i++) s += x[i] * y[i];
    return s;
  }
}
