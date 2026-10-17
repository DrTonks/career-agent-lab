/** Structural coverage and source-derived retrieval probes, not human relevance labels. */
import assert from "node:assert/strict";
import { parseArgs } from "node:util";
import { existsSync, mkdirSync, writeFileSync, cpSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnv, hash, config } from "../src/config.js";
import { loadDataset } from "../src/data.js";
import { Knowledge, jobConstraintCheck } from "../src/retrieval.js";
import { ExactVectors, localBackend } from "../src/vectors.js";
import { Store } from "../src/storage.js";
import { Runtime } from "../src/runtime.js";
import { ReplayProvider } from "../src/providers.js";
import { Request, Constraints } from "../src/contracts.js";
import { DomainTools } from "../src/tools.js";

loadEnv();
process.env.CAREER_EMBEDDING_LOCAL_ONLY = "true";
const { values: v } = parseArgs({
  options: {
    dataset: { type: "string" },
    index: { type: "string" },
    out: { type: "string" },
  },
});
if (!v.dataset || !v.index || !v.out)
  throw new Error("--dataset --index --out required");
const out = resolve(v.out);
if (existsSync(out))
  throw new Error("Audit output exists; choose a new directory");
mkdirSync(out, { recursive: true });
try {
  const data = loadDataset(resolve(v.dataset)),
    plain = new Knowledge(data),
    signal = new AbortController().signal;
  const backend = await localBackend(signal),
    vectors = new ExactVectors(resolve(v.index), plain.snapshotHash, backend);
  const k = new Knowledge(data, vectors);
  cpSync(resolve(v.dataset), resolve(out, "dataset.json"));
  mkdirSync(resolve(out, "index"));
  for (const file of ["manifest.json", vectors.manifest.vectorFile])
    cpSync(resolve(v.index, file), resolve(out, "index", file));
  const byDoc = new Map<string, typeof vectors.manifest.chunks>();
  for (const chunk of vectors.manifest.chunks)
    byDoc.set(chunk.documentId, [
      ...(byDoc.get(chunk.documentId) ?? []),
      chunk,
    ]);
  let checked = 0;
  for (const doc of k.docs) {
    let covered = 0;
    for (const chunk of byDoc.get(doc.id) ?? []) {
      assert(
        chunk.start <= covered &&
          chunk.end > chunk.start &&
          chunk.end <= doc.text.length,
        `Coverage gap: ${doc.id}`,
      );
      const text = doc.text.slice(chunk.start, chunk.end);
      assert.equal(hash(text), chunk.textHash);
      assert.equal(
        backend.countTokens(backend.options.documentPrefix + text),
        chunk.tokens,
      );
      assert(chunk.tokens <= 512);
      covered = Math.max(covered, chunk.end);
      checked++;
    }
    assert.equal(covered, doc.text.length, `Tail omitted: ${doc.id}`);
  }
  console.log(
    JSON.stringify({
      coverageDocuments: k.docs.length,
      checkedChunks: checked,
    }),
  );
  const probes = data.jobs
    .filter((j) => j.jd.length > 1800)
    .sort((a, b) => b.jd.length - a.jd.length || a.id.localeCompare(b.id))
    .slice(0, 12);
  const results = [];
  for (const job of probes) {
    const sentences = job.jd
      .slice(Math.floor(job.jd.length * 0.7))
      .split(/[。；;\n\r]+/)
      .map((s) => s.trim())
      .filter((s) => s.length >= 16 && s.length <= 160);
    const query = sentences.at(-1) ?? job.jd.slice(-100);
    const lexical = await plain.search(
      "match",
      query,
      { kind: "job", limit: 15 },
      signal,
    );
    const hybrid = await k.search(
      "match",
      query,
      { kind: "job", limit: 15 },
      signal,
    );
    const target = `job:${job.id}`;
    results.push({
      target,
      query,
      querySource:
        "last eligible sentence in final 30% of JD; source-derived probe, not relevance gold",
      lexical,
      hybrid,
      lexicalTargetRank:
        lexical.findIndex((h) => h.evidence.id === target) + 1 || null,
      hybridTargetRank:
        hybrid.findIndex((h) => h.evidence.id === target) + 1 || null,
    });
    writeFileSync(
      resolve(out, "probes.partial.json"),
      JSON.stringify(results, null, 2),
    );
  }
  const s = new Store(resolve(out, "tools.sqlite"));
  const toolCases = [];
  try {
    for (const [name, constraints] of [
      ["impossible-city", { cities: ["不存在的验证城市"] }],
      [
        "strict-unknowns",
        {
          weekendsOff: true,
          education: "本科",
          experienceYears: 0,
          minMonthlySalary: 5000,
        },
      ],
    ] as const) {
      const run = new Runtime(s, k, new ReplayProvider([]), config()).create(
        Request.parse({
          userId: `audit-${name}`,
          conversationId: "audit",
          request: "岗位检索验证",
          constraints,
        }),
      );
      const tools = new DomainTools("match", run, "match", s, k, [], signal);
      const result = (await tools.invoke(
        "jobs_search",
        { query: "软件开发 数据分析", limit: 15 },
        name,
      )) as any;
      for (const hit of result.eligible)
        assert(
          jobConstraintCheck(
            data.jobs.find((j) => j.id === hit.jobId)!,
            Constraints.parse(constraints),
          ).eligible,
        );
      for (const hit of result.uncertain) {
        const check = jobConstraintCheck(
          data.jobs.find((j) => j.id === hit.jobId)!,
          Constraints.parse(constraints),
        );
        assert(!check.violations.length && check.unknowns.length);
      }
      if (name === "impossible-city")
        assert.equal(result.eligible.length + result.uncertain.length, 0);
      toolCases.push({ name, constraints, result });
    }
  } finally {
    s.close();
  }
  const report = {
    status: "passed",
    scope:
      "structural/index coverage and source-derived retrieval diagnostics; no relevance or architecture-quality conclusion",
    snapshotHash: k.snapshotHash,
    indexFingerprint: vectors.fingerprint,
    documents: k.docs.length,
    chunks: checked,
    probes: results,
    toolCases,
    summary: {
      probes: results.length,
      lexicalTargetAt15: results.filter((r) => r.lexicalTargetRank !== null)
        .length,
      hybridTargetAt15: results.filter((r) => r.hybridTargetRank !== null)
        .length,
    },
  };
  writeFileSync(resolve(out, "result.json"), JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify({
      status: report.status,
      documents: report.documents,
      chunks: checked,
      ...report.summary,
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
