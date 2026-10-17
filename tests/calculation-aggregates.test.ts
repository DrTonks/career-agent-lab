import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { ROOT } from "../src/config.js";
import { Store } from "../src/storage.js";
import { Runtime } from "../src/runtime.js";
import { ReplayProvider } from "../src/providers.js";
import { DomainTools } from "../src/tools.js";
import { Knowledge } from "../src/retrieval.js";
import { loadDataset } from "../src/data.js";
import { calculationEvidence } from "../src/calculation.js";
import {
  countCandidates,
  calculationFacts,
  validateCalculationClaims,
} from "../src/calculation-review.js";
import { reviewUnits, type ReviewSource } from "../src/assertion-review.js";
import {
  readReviewEvidence,
  reviewSourceDirectory,
} from "../src/review-evidence.js";
import { config } from "./test-config.js";

async function actualSource(): Promise<ReviewSource> {
  const store = new Store(":memory:"),
    knowledge = new Knowledge(
      loadDataset(resolve(ROOT, "data/synthetic/dataset.json")),
    );
  try {
    const run = new Runtime(
      store,
      knowledge,
      new ReplayProvider([]),
      config(),
    ).create({
      userId: "u",
      conversationId: "c",
      request: "北京前端岗位，保留未知条件",
      constraints: { cities: ["北京"], experienceYears: 0, weekendsOff: true },
    });
    const tools = new DomainTools(
      "match",
      run,
      "match",
      store,
      knowledge,
      [],
      new AbortController().signal,
    );
    const result = (await tools.invoke(
      "jobs_search",
      { query: "前端", categoryIds: [], limit: 5 },
      "search",
    )) as any;
    const e = result.evidence;
    assert.deepEqual(result.categoryPartition, {
      scheme: "single-category-per-record-v1",
      recordCount: 24,
    });
    return {
      id: "calc",
      kind: "calculation",
      text: e.text,
      origin: { sourceId: e.id, version: e.version, artifactId: "match" },
    };
  } finally {
    store.close();
  }
}
function altered(s: ReviewSource, change: (body: any) => void): ReviewSource {
  const body = JSON.parse(s.text);
  change(body);
  const e = calculationEvidence(body);
  return {
    ...s,
    text: e.text,
    origin: { ...s.origin!, sourceId: e.id, version: e.version },
  };
}
const sumDraft = "frontend-mid/senior 的 8 条岗位全部因经验被排除。";
const eachDraft =
  "frontend-mid/senior 各 4 条岗位全部因经验被排除；frontend-junior 有 0 条因经验被排除。";
const supported = [{ unitIds: [0], verdict: "supported" }];
test("real jobs_search partition supports an exact category-subset sum with inspectable operands, not a corpus total", async () => {
  const s = await actualSource(),
    c = countCandidates(reviewUnits(sumDraft)),
    facts = calculationFacts([s], [s], c);
  assert.equal(c[0]!.metric, "exclusion:experience");
  const f = facts.find(
    (f) => f.operation === "sum" && f.pointer.endsWith("/experience"),
  )!;
  assert.equal(f.value, 8);
  assert.deepEqual(f.scope.quantifiedCategoryIds, [
    "frontend-mid",
    "frontend-senior",
  ]);
  assert.deepEqual(
    (f.scope.operands as any[]).map((o) => o.value),
    [4, 4],
  );
  assert(
    (f.scope.operands as any[]).every((o) =>
      o.pointer.endsWith("/exclusionCounts/experience"),
    ),
  );
  const bindings = [{ candidateId: c[0]!.id, factId: f.id }];
  assert.equal(
    validateCalculationClaims(sumDraft, bindings, supported, [s], [s]).length,
    1,
  );
  const wrong = facts.find((f) => f.operation === "scalar" && f.value === 4)!;
  assert.throws(
    () =>
      validateCalculationClaims(
        sumDraft,
        [{ candidateId: c[0]!.id, factId: wrong.id }],
        supported,
        [s],
        [s],
      ),
    /field\/value mismatch/,
  );
});
test("each-category claims use all_equal for exactly the named subset and cannot borrow sum or another clause's category", async () => {
  const s = await actualSource(),
    c = countCandidates(reviewUnits(eachDraft)),
    facts = calculationFacts([s], [s], c);
  assert.deepEqual(
    c.map((c) => c.metric),
    ["all:exclusion:experience", "exclusion:experience"],
  );
  const all = facts.find(
    (f) => f.operation === "all_equal" && f.pointer.endsWith("/experience"),
  )!;
  assert.equal(all.value, 4);
  assert.deepEqual(all.scope.quantifiedCategoryIds, [
    "frontend-mid",
    "frontend-senior",
  ]);
  const junior = facts.find(
    (f) =>
      f.scope.categoryId === "frontend-junior" &&
      f.pointer.endsWith("/experience"),
  )!;
  assert.equal(
    validateCalculationClaims(
      eachDraft,
      [
        { candidateId: c[0]!.id, factId: all.id },
        { candidateId: c[1]!.id, factId: junior.id },
      ],
      supported,
      [s],
      [s],
    ).length,
    2,
  );
});
test("sum requires the observed partition and complete category rows; field reads carry the same actual partition", async () => {
  const s = await actualSource(),
    c = countCandidates(reviewUnits(sumDraft));
  const directory = reviewSourceDirectory([s])[0]! as any;
  const pages = readReviewEvidence(
    {
      requests: [
        {
          sourceId: s.id,
          sourceHash: directory.structured.sourceHash,
          pointer: "/result/categoryCoverage",
        },
      ],
    },
    [s],
  );
  assert(calculationFacts(pages, [s], c).some((f) => f.operation === "sum"));
  const partitionText = JSON.stringify(
    JSON.parse(s.text).result.categoryPartition,
  );
  const partitionStart = s.text.indexOf(partitionText);
  const withoutPartition = pages.flatMap((p) => {
    if (!p.window) return [];
    const a = p.window.start,
      b = p.window.end;
    if (b <= partitionStart || a >= partitionStart + partitionText.length)
      return [p];
    return [];
  });
  assert(
    !calculationFacts(withoutPartition, [s], c).some(
      (f) => f.operation === "sum",
    ),
  );
  for (const change of [
    (b: any) => delete b.result.categoryPartition,
    (b: any) => b.result.categoryPartition.recordCount++,
    (b: any) =>
      (b.result.categoryCoverage[2].categoryId =
        b.result.categoryCoverage[1].categoryId),
    (b: any) => (b.result.categoryCoverage[1].exclusionCounts.experience = 5),
    (b: any) => (b.result.categoryCoverage[1] = null),
    (b: any) => delete b.result.categoryCoverage[1].categoryId,
    (b: any) => (b.tool = "graph_paths"),
  ]) {
    const bad = altered(s, change);
    assert(
      !calculationFacts([bad], [bad], c).some((f) => f.operation === "sum"),
    );
  }
});
test("separate query windows and unnamed category groups cannot silently become a sum", async () => {
  const s = await actualSource(),
    c = countCandidates(reviewUnits(sumDraft));
  const other = altered(s, (b) => (b.arguments.query = "另一查询"));
  assert(!calculationFacts([other], [s], c).some((f) => f.operation === "sum"));
  assert(
    !calculationFacts(
      [s],
      [s],
      countCandidates(reviewUnits("8 条岗位全部因经验被排除。")),
    ).some((f) => f.operation === "sum"),
  );
  const unknown = countCandidates(
    reviewUnits("frontend-mid/unknown 的 8 条岗位全部因经验被排除。"),
  );
  assert(
    !calculationFacts([s], [s], unknown).some((f) => f.operation === "sum"),
  );
  for (const text of [
    "frontend-mid/senior/unknown 各 4 条因经验被排除。",
    "frontend-mid/senior/unknown 的 8 条岗位因经验被排除。",
  ])
    assert(
      !calculationFacts([s], [s], countCandidates(reviewUnits(text))).some(
        (f) => ["sum", "all_equal"].includes(f.operation),
      ),
    );
});
