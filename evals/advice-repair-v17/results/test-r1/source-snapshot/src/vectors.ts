import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  renameSync,
} from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { hash, readJson, ROOT } from "./config.js";
import { Knowledge, VectorSearch } from "./retrieval.js";
import { CHUNK_POLICY, chunkText } from "./chunking.js";

export interface EmbeddingOptions {
  baseUrl: string;
  model: string;
  revision: string;
  dimensions: number;
  queryPrefix: string;
  documentPrefix: string;
}
export interface EmbeddingBackend {
  options: EmbeddingOptions;
  countTokens(text: string): number;
  encode(
    texts: string[],
    signal: AbortSignal,
  ): Promise<{ vectors: number[][]; tokens: number | null }>;
}
const DEFAULT_MODEL = "Xenova/bge-small-zh-v1.5";
const DEFAULT_REVISION = "75c43b069aac4d136ba6bc1122f995fedcfd2781";
export function embeddingOptions(): EmbeddingOptions {
  if ((process.env.CAREER_EMBEDDING_MODE ?? "local") !== "local")
    throw new Error("Only local embeddings are configured");
  const model = process.env.CAREER_EMBEDDING_MODEL || DEFAULT_MODEL;
  const revision =
    process.env.CAREER_LOCAL_EMBEDDING_REVISION ||
    (model === DEFAULT_MODEL ? DEFAULT_REVISION : "");
  if (!/^[a-f0-9]{40}$/i.test(revision))
    throw new Error(
      "Embedding requires an immutable 40-character model revision",
    );
  return {
    baseUrl: `local:onnx:cls:q8:512:${revision}`,
    model,
    revision,
    dimensions: 512,
    queryPrefix:
      process.env.CAREER_EMBEDDING_QUERY_PREFIX ??
      "为这个句子生成表示以用于检索相关文章：",
    documentPrefix: process.env.CAREER_EMBEDDING_DOCUMENT_PREFIX ?? "",
  };
}
export function embeddingSource(
  options: EmbeddingOptions,
  localOnly: boolean,
  cacheRoot = resolve(ROOT, ".models"),
) {
  const directory = resolve(cacheRoot, options.model, options.revision);
  const complete = [
    "config.json",
    "tokenizer.json",
    "tokenizer_config.json",
    "onnx/model_quantized.onnx",
  ].every((file) => existsSync(resolve(directory, file)));
  if (complete) return directory;
  if (localOnly)
    throw new Error(
      "Pinned local embedding cache is incomplete; prepare the model before offline execution",
    );
  return options.model;
}
const extractors = new Map<string, Promise<any>>();
export async function localBackend(
  signal: AbortSignal,
): Promise<EmbeddingBackend> {
  signal.throwIfAborted();
  const options = embeddingOptions(),
    key = hash(options);
  if (!extractors.has(key))
    extractors.set(
      key,
      (async () => {
        const { AutoTokenizer, AutoModel, FeatureExtractionPipeline, env } =
          await import("@huggingface/transformers");
        env.cacheDir = resolve(ROOT, ".models");
        if (process.env.CAREER_MODEL_DOWNLOAD_HOST)
          env.remoteHost = process.env.CAREER_MODEL_DOWNLOAD_HOST;
        // The registry in transformers 4.3.1 probes metadata at main even
        // through AutoTokenizer. A complete pinned cache is a local directory,
        // so metadata probes cannot fall through to the network.
        const source = embeddingSource(
          options,
          process.env.CAREER_EMBEDDING_LOCAL_ONLY === "true",
        );
        const loading = {
          revision: options.revision,
          local_files_only: process.env.CAREER_EMBEDDING_LOCAL_ONLY === "true",
        };
        const tokenizer = await AutoTokenizer.from_pretrained(source, loading);
        const model = await AutoModel.from_pretrained(source, {
          ...loading,
          dtype: "q8",
          device: "cpu",
        });
        return new FeatureExtractionPipeline({
          task: "feature-extraction",
          tokenizer,
          model,
        });
      })().catch((e) => {
        extractors.delete(key);
        throw e;
      }),
    );
  const extractor = await extractors.get(key)!;
  signal.throwIfAborted();
  if (extractor.tokenizer.model_max_length < CHUNK_POLICY.maxTokens)
    throw new Error(
      "Tokenizer capacity is smaller than the configured chunk window",
    );
  const countTokens = (text: string): number =>
    extractor.tokenizer.encode(text, { add_special_tokens: true }).length;
  return {
    options,
    countTokens,
    async encode(texts, currentSignal) {
      currentSignal.throwIfAborted();
      if (texts.some((t) => countTokens(t) > CHUNK_POLICY.maxTokens))
        throw new Error(
          "Refusing silent embedding truncation; split text first",
        );
      const result = await extractor(texts, {
        pooling: "cls",
        normalize: true,
      });
      currentSignal.throwIfAborted();
      const vectors = result.tolist() as number[][];
      validateVectors(vectors, texts.length, options.dimensions);
      return { vectors, tokens: null };
    },
  };
}
function validateVectors(
  vectors: number[][],
  count: number,
  dimensions: number,
) {
  if (
    !Array.isArray(vectors) ||
    vectors.length !== count ||
    vectors.some(
      (v) =>
        !Array.isArray(v) ||
        v.length !== dimensions ||
        !v.every(Number.isFinite) ||
        !v.some((n) => n !== 0),
    )
  )
    throw new Error("Invalid embedding output or cached batch");
}
const normalize = (v: number[]) => {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  if (!Number.isFinite(n) || !n) throw new Error("Invalid embedding norm");
  return v.map((x) => x / n);
};
function atomicWrite(path: string, data: string | Buffer) {
  const temporary = path + "." + randomUUID() + ".tmp";
  writeFileSync(temporary, data);
  renameSync(temporary, path);
}
const Chunk = z
  .object({
    id: z.string(),
    documentId: z.string(),
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
    textHash: z.string(),
    tokens: z.number().int().min(1).max(512),
  })
  .strict();
const Manifest = z
  .object({
    version: z.literal(2),
    model: z.string(),
    revision: z.string(),
    dimensions: z.number().int().positive(),
    queryPrefix: z.string(),
    documentPrefix: z.string(),
    snapshotHash: z.string(),
    ids: z.array(z.string()),
    chunks: z.array(Chunk),
    policy: z.literal(CHUNK_POLICY.version),
    vectorFile: z.string().regex(/^vectors-[a-f0-9]{64}\.f32$/),
    vectorHash: z.string(),
    provider: z.string(),
    createdAt: z.string(),
  })
  .strict();
export type IndexManifest = z.infer<typeof Manifest>;

/** Optional backend is explicit test dependency injection, never a fallback. */
export async function buildIndex(
  knowledge: Knowledge,
  directory: string,
  signal: AbortSignal,
  onProgress?: (v: unknown) => void,
  backend?: EmbeddingBackend,
) {
  backend ??= await localBackend(signal);
  const o = backend.options;
  mkdirSync(directory, { recursive: true });
  const chunks = knowledge.docs.flatMap((doc) =>
    chunkText(doc.text, backend.countTokens, o.documentPrefix).map((span) => ({
      ...span,
      id: `${doc.id}@${span.start}:${span.end}`,
      documentId: doc.id,
      textHash: hash(span.text),
    })),
  );
  const identity = hash({
    snapshot: knowledge.snapshotHash,
    options: o,
    policy: CHUNK_POLICY,
  });
  const cacheDir = resolve(directory, "batches");
  mkdirSync(cacheDir, { recursive: true });
  const vectors: number[][] = [];
  for (let offset = 0; offset < chunks.length; offset += 8) {
    signal.throwIfAborted();
    const batch = chunks.slice(offset, offset + 8),
      path = resolve(
        cacheDir,
        hash([identity, batch.map((c) => [c.id, c.textHash])]) + ".json",
      );
    const cached = existsSync(path);
    const result = cached
      ? readJson<{ vectors: number[][]; tokens: number | null }>(path)
      : await backend.encode(
          batch.map((c) => o.documentPrefix + c.text),
          signal,
        );
    signal.throwIfAborted();
    validateVectors(result.vectors, batch.length, o.dimensions);
    if (!cached) atomicWrite(path, JSON.stringify(result));
    vectors.push(...result.vectors.map(normalize));
    onProgress?.({
      completed: vectors.length,
      total: chunks.length,
      documents: knowledge.docs.length,
      cached,
    });
  }
  signal.throwIfAborted();
  const bytes = Buffer.alloc(vectors.length * o.dimensions * 4);
  vectors.forEach((v, i) =>
    v.forEach((x, j) => bytes.writeFloatLE(x, (i * o.dimensions + j) * 4)),
  );
  const vectorHash = hash(bytes.toString("base64")),
    vectorFile = `vectors-${vectorHash}.f32`;
  atomicWrite(resolve(directory, vectorFile), bytes);
  const manifest: IndexManifest = {
    version: 2,
    model: o.model,
    revision: o.revision,
    dimensions: o.dimensions,
    queryPrefix: o.queryPrefix,
    documentPrefix: o.documentPrefix,
    snapshotHash: knowledge.snapshotHash,
    ids: knowledge.docs.map((d) => d.id),
    chunks: chunks.map(({ text, ...chunk }) => chunk),
    policy: CHUNK_POLICY.version,
    vectorFile,
    vectorHash,
    provider: o.baseUrl,
    createdAt: new Date().toISOString(),
  };
  // Immutable vector file first; manifest is the atomic publication point.
  atomicWrite(
    resolve(directory, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
  return {
    vectors: vectors.length,
    documents: knowledge.docs.length,
    dimensions: o.dimensions,
    newTokens: null,
    manifest,
  };
}

export class ExactVectors implements VectorSearch {
  readonly mode = "chunked-exact-cosine";
  readonly manifest: IndexManifest;
  readonly fingerprint: string;
  private bytes: Buffer;
  private options: EmbeddingOptions;
  onUsage?: (value: {
    model: string;
    input: number | null;
    durationMs: number;
  }) => void;
  constructor(
    directory: string,
    snapshotHash: string,
    private backend?: EmbeddingBackend,
  ) {
    const raw = readJson<any>(resolve(directory, "manifest.json"));
    if (raw.version !== 2)
      throw new Error(
        "Legacy truncating index: build a v2 chunk index in a new directory; retain old snapshots",
      );
    this.manifest = Manifest.parse(raw);
    this.options = backend?.options ?? embeddingOptions();
    const m = this.manifest,
      o = this.options;
    if (
      m.snapshotHash !== snapshotHash ||
      m.model !== o.model ||
      m.revision !== o.revision ||
      m.dimensions !== o.dimensions ||
      m.queryPrefix !== o.queryPrefix ||
      m.documentPrefix !== o.documentPrefix ||
      m.provider !== o.baseUrl
    )
      throw new Error(
        "Index/model/preprocessing mismatch; rebuild or select matching configuration",
      );
    const ids = new Set(m.ids);
    if (
      ids.size !== m.ids.length ||
      new Set(m.chunks.map((c) => c.id)).size !== m.chunks.length ||
      m.chunks.some((c) => !ids.has(c.documentId) || c.end <= c.start)
    )
      throw new Error("Invalid chunk provenance");
    this.bytes = readFileSync(resolve(directory, m.vectorFile));
    if (
      this.bytes.length !== m.chunks.length * m.dimensions * 4 ||
      hash(this.bytes.toString("base64")) !== m.vectorHash
    )
      throw new Error("Corrupt vector index");
    this.fingerprint = hash({ ...m, createdAt: undefined });
  }
  async rank(query: string, ids: string[], signal: AbortSignal) {
    if (!ids.length || !query.trim()) return [];
    signal.throwIfAborted();
    this.backend ??= await localBackend(signal);
    if (hash(this.backend.options) !== hash(this.options))
      throw new Error(
        "Embedding configuration changed after loading the index",
      );
    const spans = chunkText(
      query,
      this.backend.countTokens,
      this.options.queryPrefix,
    );
    const start = performance.now(),
      result = await this.backend.encode(
        spans.map((s) => this.options.queryPrefix + s.text),
        signal,
      );
    validateVectors(result.vectors, spans.length, this.options.dimensions);
    this.onUsage?.({
      model: this.options.model,
      input: result.tokens,
      durationMs: performance.now() - start,
    });
    const queries = result.vectors.map(normalize),
      allowed = new Set(ids),
      d = this.manifest.dimensions;
    const best = new Map<
      string,
      {
        id: string;
        score: number;
        passage: { start: number; end: number; chunkId: string };
      }
    >();
    this.manifest.chunks.forEach((chunk, i) => {
      if (!allowed.has(chunk.documentId)) return;
      let score = -Infinity;
      for (const q of queries) {
        let cosine = 0;
        for (let j = 0; j < d; j++)
          cosine += q[j]! * this.bytes.readFloatLE((i * d + j) * 4);
        score = Math.max(score, cosine);
      }
      if (score > (best.get(chunk.documentId)?.score ?? -Infinity))
        best.set(chunk.documentId, {
          id: chunk.documentId,
          score,
          passage: { start: chunk.start, end: chunk.end, chunkId: chunk.id },
        });
    });
    signal.throwIfAborted();
    return [...best.values()]
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      .slice(0, 60);
  }
}
