import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { Store } from "../src/storage.js";
import { Knowledge } from "../src/retrieval.js";
import { DomainTools } from "../src/tools.js";
import { Runtime } from "../src/runtime.js";
import { ReplayProvider } from "../src/providers.js";
import { loadDataset } from "../src/data.js";
import { ROOT } from "../src/config.js";
import { config } from "./test-config.js";
import { Request, type Artifact, type Evidence } from "../src/contracts.js";
import { rememberEvidence, supportsQuote } from "../src/evidence.js";

test("read ledger retains earlier pages and rejects quotes across unseen gaps or changed sources", () => {
  const seen = new Map<string, Evidence>();
  const e: Evidence = {
    id: "s",
    sourceId: "s",
    version: "v1",
    kind: "resume",
    text: "first page",
  };
  rememberEvidence(seen, e);
  rememberEvidence(seen, { ...e, text: "last page" });
  rememberEvidence(seen, { ...e, text: "first page" });
  assert.equal(seen.get("s")!.readTexts!.length, 2);
  assert(supportsQuote(seen.get("s")!, "first page"));
  assert(supportsQuote(seen.get("s")!, "last page"));
  assert(!supportsQuote(seen.get("s")!, "page last"));
  assert(!supportsQuote(seen.get("s")!, "unread middle"));
  assert.throws(
    () => rememberEvidence(seen, { ...e, version: "v2" }),
    /changed/,
  );
});

test("published search excerpt delegates only its source and supports full-source pagination without unread citations", async () => {
  const data = loadDataset(resolve(ROOT, "data/synthetic/dataset.json"));
  const text = "起始限定条件。" + "普通描述".repeat(2000) + "末尾限定条件。";
  data.documents.push({
    id: "long",
    sourceId: "long",
    kind: "rule",
    roles: ["match"],
    text,
  });
  data.documents.push({
    id: "private",
    sourceId: "private",
    kind: "rule",
    roles: ["match"],
    text: "未交接",
  });
  const k = new Knowledge(data),
    s = new Store(":memory:");
  try {
    const run = new Runtime(s, k, new ReplayProvider([]), config()).create(
      Request.parse({ userId: "reader", conversationId: "c", request: "报告" }),
    );
    const excerpt = {
      ...k.get("match", "long"),
      text: text.slice(-200),
      readTexts: [text.slice(-200)],
    };
    const a: Artifact = {
      id: "upstream",
      runId: run.id,
      stepId: "match",
      expert: "match",
      version: 1,
      result: {
        status: "partial",
        summary: "匹配",
        evidenceIds: ["long"],
        unknowns: [],
        conflicts: [],
        nextActions: [],
        artifact: {},
      },
      publishedEvidence: [excerpt],
    };
    const tools = new DomainTools(
      "report",
      run,
      "report",
      s,
      k,
      [a],
      new AbortController().signal,
    );
    const meta = (await tools.invoke(
      "artifact_read",
      { id: "upstream" },
      "meta",
    )) as any;
    assert.equal(meta.publishedSources[0].totalChars, text.length);
    assert(!JSON.stringify(meta).includes("末尾限定条件"));
    assert.throws(() => tools.assertEvidence(["long"]), /Unread/);
    const first = (await tools.invoke(
      "knowledge_read",
      { id: "long", offset: 0, maxChars: 200 },
      "first",
    )) as any;
    assert.equal(first.totalChars, text.length);
    assert(first.evidence.text.startsWith("起始限定条件"));
    assert(!supportsQuote(tools.seen.get("long")!, "末尾限定条件"));
    await tools.invoke(
      "knowledge_read",
      { id: "long", offset: text.length - 200, maxChars: 200 },
      "last",
    );
    assert(supportsQuote(tools.seen.get("long")!, "起始限定条件"));
    assert(supportsQuote(tools.seen.get("long")!, "末尾限定条件"));
    await assert.rejects(
      tools.invoke("knowledge_read", { id: "private" }, "deny"),
      /not accessible/,
    );
    const resumed = new DomainTools(
      "report",
      run,
      "report",
      s,
      k,
      [a],
      new AbortController().signal,
    );
    resumed.remember(JSON.parse(JSON.stringify([...tools.seen.values()])));
    assert(supportsQuote(resumed.seen.get("long")!, "起始限定条件"));
    assert.throws(
      () => k.publishedSource({ ...excerpt, version: "wrong" }),
      /provenance/,
    );
    assert.throws(
      () => k.publishedSource({ ...excerpt, text: "伪造来源" }),
      /provenance/,
    );
  } finally {
    s.close();
  }
});
