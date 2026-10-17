import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { Runtime } from "../src/runtime.js";
import { DomainTools } from "../src/tools.js";
import { Store } from "../src/storage.js";
import { ReplayProvider } from "../src/providers.js";
import { Knowledge } from "../src/retrieval.js";
import { loadDataset } from "../src/data.js";
import { ROOT } from "../src/config.js";
import { config } from "./test-config.js";
import { calculationEvidence, parseCalculation } from "../src/calculation.js";
import {
  calculationFacts,
  countCandidates,
  validateCalculationClaims,
} from "../src/calculation-review.js";
import { reviewUnits, type ReviewSource } from "../src/assertion-review.js";
import { readReviewEvidence } from "../src/review-evidence.js";
import { reviewSourceHash } from "../src/source-fields.js";
import type { Artifact, Evidence } from "../src/contracts.js";

function setup() {
  const store = new Store(":memory:");
  const insert = store.db.prepare(
    "INSERT INTO memories(user_id,namespace,key,value,version,source_run,evidence,updated_at,retracted,expires_at) VALUES(?,?,?,?,1,'fixture','[]','2026-01-01T00:00:00Z',?,?)",
  );
  for (const row of [
    ["u", "shared", "city", "成都", 0, null],
    ["u", "profile", "skill", "TypeScript", 0, null],
    ["u", "profile", "expired", "EXPIRED_PRIVATE", 0, "2020-01-01T00:00:00Z"],
    ["u", "profile", "retracted", "RETRACTED_PRIVATE", 1, null],
    ["u", "match", "private", "OTHER_ROLE_SECRET", 0, null],
    ["other", "profile", "private", "OTHER_USER_SECRET", 0, null],
  ] as const)
    insert.run(...row);
  const knowledge = new Knowledge(
    loadDataset(resolve(ROOT, "data/synthetic/dataset.json")),
  );
  const runtime = new Runtime(
    store,
    knowledge,
    new ReplayProvider([]),
    config(),
  );
  const run = runtime.create({
    userId: "u",
    conversationId: "c",
    request: "画像",
  });
  const tools = new DomainTools(
    "profile",
    run,
    "profile",
    store,
    knowledge,
    [],
    new AbortController().signal,
  );
  return { store, tools, run, knowledge };
}
function source(e: Evidence): ReviewSource {
  return {
    id: e.id,
    kind: "calculation",
    text: e.text,
    origin: { sourceId: e.id, version: e.version, artifactId: "fixture" },
  };
}

test("actual memory recall publishes authorized totals, query matches and page size without private values or false zero-total inference", async () => {
  const { store, tools, run, knowledge } = setup();
  try {
    const first = (await tools.invoke(
      "memory_recall",
      { limit: 1 },
      "page1",
    )) as any;
    const body = parseCalculation(first.evidence);
    assert.equal(body.tool, "memory_recall");
    assert.deepEqual(body.result.counts, {
      totalAvailable: 2,
      totalMatches: 2,
      returnedCount: 1,
    });
    assert.deepEqual((body.result.memoryScope as any).namespaces, [
      "shared",
      "profile",
    ]);
    assert(first.nextCursor);
    const next = (await tools.invoke(
      "memory_recall",
      { limit: 1, cursor: first.nextCursor },
      "page2",
    )) as any;
    assert.equal(next.nextCursor, null);
    assert.notEqual(next.evidence.id, first.evidence.id);
    const zero = (await tools.invoke(
      "memory_recall",
      { query: "quartznohit739" },
      "zero",
    )) as any;
    assert.deepEqual(parseCalculation(zero.evidence).result.counts, {
      totalAvailable: 2,
      totalMatches: 0,
      returnedCount: 0,
    });
    const inactive = (await tools.invoke(
      "memory_recall",
      { includeInactive: true },
      "inactive",
    )) as any;
    assert.equal(inactive.totalAvailable, 4);
    for (const value of [first, next, zero, inactive]) {
      assert(
        !/OTHER_ROLE_SECRET|OTHER_USER_SECRET|EXPIRED_PRIVATE|RETRACTED_PRIVATE/.test(
          JSON.stringify(value),
        ),
      );
      assert(tools.seen.has(value.evidence.id));
    }
    const restored = new DomainTools(
      "profile",
      run,
      "profile",
      store,
      knowledge,
      [],
      new AbortController().signal,
    );
    const reread = (await restored.invoke(
      "knowledge_read",
      { id: zero.evidence.id },
      "read",
    )) as any;
    assert.equal(reread.evidence.id, zero.evidence.id);
    const foreign = new DomainTools(
      "match",
      run,
      "match",
      store,
      knowledge,
      [],
      new AbortController().signal,
    );
    await assert.rejects(
      foreign.invoke("knowledge_read", { id: zero.evidence.id }, "deny"),
      /outside the active expert inputs/,
    );
    const publication: Artifact = {
      id: `${run.id}:profile`,
      runId: run.id,
      stepId: "profile",
      expert: "profile",
      version: 1,
      result: {
        status: "partial",
        summary: "角色授权记忆查询",
        artifact: {},
        evidenceIds: [zero.evidence.id],
        unknowns: [],
        conflicts: [],
        nextActions: [],
      },
      publishedEvidence: [zero.evidence],
    };
    const downstream = new DomainTools(
      "report",
      run,
      "report",
      store,
      knowledge,
      [publication],
      new AbortController().signal,
    );
    assert.throws(
      () => downstream.assertEvidence([zero.evidence.id]),
      /Unread/,
    );
    const handedOff = (await downstream.invoke(
      "knowledge_read",
      { id: zero.evidence.id, maxChars: 6000 },
      "published-read",
    )) as any;
    downstream.assertEvidence([zero.evidence.id]);
    // Publication grants the receipt, not the producer's private memory entries.
    assert.deepEqual(
      parseCalculation(handedOff.evidence).result.memoryScope,
      parseCalculation(zero.evidence).result.memoryScope,
    );
    assert(!/TypeScript|成都/.test(handedOff.evidence.text));
    const reportScope = (await downstream.invoke(
      "memory_recall",
      {},
      "own-recall",
    )) as any;
    assert.equal(reportScope.totalAvailable, 1);
    assert.deepEqual(
      (parseCalculation(reportScope.evidence).result.memoryScope as any)
        .namespaces,
      ["shared", "report"],
    );
    assert.deepEqual(
      (
        (await tools.invoke(
          "memory_recall",
          { query: "quartznohit739" },
          "retry",
        )) as any
      ).evidence,
      zero.evidence,
    );
    store.db
      .prepare(
        "UPDATE memories SET version=2 WHERE user_id='u' AND namespace='profile' AND key='skill'",
      )
      .run();
    await assert.rejects(
      restored.invoke("knowledge_read", { id: zero.evidence.id }, "stale"),
      /Durable memory changed/,
    );
  } finally {
    store.close();
  }
});

test("memory count bindings distinguish available, query and page metrics and reject a same-valued job receipt", async () => {
  const { store, tools, run, knowledge } = setup();
  try {
    const memory = (await tools.invoke(
      "memory_recall",
      { query: "quartznohit739", limit: 1 },
      "zero",
    )) as any;
    const s = source(memory.evidence),
      draft = "本角色可见记忆总数2条；记忆查询命中0条；本页记忆返回0条。",
      units = reviewUnits(draft),
      candidates = countCandidates(units);
    assert.deepEqual(
      candidates.map((c) => c.metric),
      ["totalavailable", "totalmatches", "returnedcount"],
    );
    const facts = calculationFacts([s], [s], candidates);
    assert.equal(facts.length, 3);
    const bindings = candidates.map((c) => ({
      candidateId: c.id,
      factId: facts.find((f) => f.pointer.toLowerCase().endsWith(c.metric))!.id,
    }));
    const judgments = units.map((u) => ({
      unitIds: [u.id],
      verdict: "supported",
    }));
    assert.equal(
      validateCalculationClaims(draft, bindings, judgments, [s], [s]).length,
      3,
    );
    await assert.rejects(
      async () =>
        validateCalculationClaims(
          draft,
          [
            {
              candidateId: candidates[1]!.id,
              factId: facts.find((f) => f.pointer.endsWith("returnedCount"))!
                .id,
            },
          ],
          judgments,
          [s],
          [s],
        ),
      /field\/value mismatch/,
    );
    const jobs = new DomainTools(
      "match",
      run,
      "match",
      store,
      knowledge,
      [],
      new AbortController().signal,
    );
    const searched = (await jobs.invoke(
      "jobs_search",
      { query: "quartznohit739", categoryIds: ["frontend-senior"] },
      "jobs",
    )) as any;
    const jobSource = source(searched.evidence);
    assert.equal(
      (parseCalculation(searched.evidence).result.counts as any).unknown,
      0,
    );
    assert.equal(
      calculationFacts(
        [jobSource],
        [jobSource],
        countCandidates(reviewUnits("本角色记忆0条。")),
      ).length,
      0,
    );
    assert.equal(
      calculationFacts([jobSource], [jobSource], candidates).length,
      0,
    );
    const jobCandidates = countCandidates(reviewUnits("岗位检索返回0条候选。"));
    assert.equal(calculationFacts([s], [s], jobCandidates).length, 0);
    const heads = (await tools.invoke(
        "memory_recall",
        { includeInactive: true },
        "heads",
      )) as any,
      headSource = source(heads.evidence);
    assert.equal(
      calculationFacts(
        [headSource],
        [headSource],
        countCandidates(reviewUnits("当前可用记忆4条。")),
      ).length,
      0,
    );
    assert.equal(
      calculationFacts(
        [headSource],
        [headSource],
        countCandidates(reviewUnits("含失效的记忆版本头共4条。")),
      ).length,
      1,
    );
  } finally {
    store.close();
  }
});

test("memory numeric pages require actual scope reads and invalid namespaces, query identities or impossible counts yield no facts", async () => {
  const { store, tools } = setup();
  try {
    const value = (await tools.invoke(
      "memory_recall",
      { query: "quartznohit739" },
      "recall",
    )) as any;
    const s = source(value.evidence),
      c = countCandidates(reviewUnits("当前角色可用记忆2条。"));
    const pages = readReviewEvidence(
      {
        requests: [
          {
            sourceId: s.id,
            sourceHash: reviewSourceHash(s),
            pointer: "/result/counts/totalAvailable",
          },
        ],
      },
      [s],
    );
    assert.equal(calculationFacts(pages, [s], c).length, 1);
    const onlyNumber = {
      ...s,
      text: '"totalAvailable":2',
      window: {
        parentId: s.id,
        start: s.text.indexOf('"totalAvailable":2'),
        end: s.text.indexOf('"totalAvailable":2') + 18,
        total: s.text.length,
      },
    };
    assert.equal(calculationFacts([onlyNumber], [s], c).length, 0);
    for (const modify of [
      (b: any) => (b.result.memoryScope.namespaces = ["shared", "match"]),
      (b: any) => (b.result.memoryScope.query = "different-query"),
      (b: any) => (b.result.counts.totalMatches = 3),
      (b: any) => (b.result.memoryScope.snapshot = "invalid"),
    ]) {
      const body = parseCalculation(value.evidence);
      modify(body);
      const { schema: _, ...input } = body;
      const bad = source(calculationEvidence(input));
      assert.equal(calculationFacts([bad], [bad], c).length, 0);
    }
  } finally {
    store.close();
  }
});
