/** Local ONNX integration check; no chat provider calls. Requires cached model. */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync, cpSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadEnv, ROOT } from "../src/config.js";
import { loadDataset } from "../src/data.js";
import { Knowledge } from "../src/retrieval.js";
import { buildIndex, ExactVectors, localBackend } from "../src/vectors.js";
import { chunkText } from "../src/chunking.js";

loadEnv();
process.env.CAREER_EMBEDDING_LOCAL_ONLY = "true";
const { values } = parseArgs({ options: { out: { type: "string" } } });
if (!values.out) throw new Error("--out NEW_DIRECTORY required");
const out = resolve(values.out);
if (existsSync(out))
  throw new Error(
    "Output exists; preserve earlier evidence and choose a new directory",
  );
mkdirSync(out, { recursive: true });
const signal = new AbortController().signal;
try {
  const backend = await localBackend(signal);
  const text =
    "日常资料整理、文件归档和团队协作。".repeat(160) +
    "核心职责：研究火星地质构造与陨石矿物，进行行星岩石成分分析。";
  const tokens = backend.countTokens(text);
  assert(
    tokens > 512,
    "Tokenizer count must expose text beyond model capacity",
  );
  await assert.rejects(backend.encode([text], signal), /truncation/);
  const spans = chunkText(
    text,
    backend.countTokens,
    backend.options.documentPrefix,
  );
  assert(spans.every((s) => s.tokens <= 512));
  assert.equal(spans.at(-1)!.end, text.length);
  const data = loadDataset(resolve(ROOT, "data/synthetic/dataset.json"));
  data.documents.push({
    id: "validation:long-tail",
    sourceId: "synthetic-long-tail",
    kind: "rule",
    roles: ["match"],
    text,
  });
  writeFileSync(resolve(out, "dataset.json"), JSON.stringify(data, null, 2));
  cpSync(resolve(ROOT, "knowledge"), resolve(out, "knowledge"), {
    recursive: true,
  });
  const knowledge = new Knowledge(data);
  const index = await buildIndex(
    knowledge,
    resolve(out, "index"),
    signal,
    (progress) => console.log(JSON.stringify(progress)),
    backend,
  );
  const vectors = new ExactVectors(
    resolve(out, "index"),
    knowledge.snapshotHash,
    backend,
  );
  const query = "火星地质构造、陨石矿物与行星岩石成分研究";
  const ranks = await vectors.rank(
    query,
    knowledge.docs.filter((d) => d.roles.includes("match")).map((d) => d.id),
    signal,
  );
  const match = ranks.find((r) => r.id === "validation:long-tail");
  assert(match);
  assert(
    text.slice(match.passage.start, match.passage.end).includes("火星地质"),
  );
  assert(
    ranks.indexOf(match) < 5,
    "Tail passage should be in top five for this focused probe",
  );
  const report = {
    status: "passed",
    scope: "local ONNX plumbing probe, not retrieval quality benchmark",
    model: backend.options,
    tokens,
    chunks: spans,
    query,
    ranks,
    documents: index.documents,
    vectors: index.vectors,
    snapshotHash: knowledge.snapshotHash,
    fingerprint: vectors.fingerprint,
  };
  writeFileSync(resolve(out, "result.json"), JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify({
      status: report.status,
      tokens,
      chunks: spans.length,
      tailRank: ranks.indexOf(match) + 1,
      documents: index.documents,
      vectors: index.vectors,
    }),
  );
} catch (error) {
  writeFileSync(
    resolve(out, "failure.json"),
    JSON.stringify(
      {
        error: String(error),
        stack: error instanceof Error ? error.stack : undefined,
      },
      null,
      2,
    ),
  );
  throw error;
}
