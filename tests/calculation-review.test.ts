import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { calculationEvidence } from "../src/calculation.js";
import {
  countCandidates,
  calculationFacts,
  validateCalculationClaims,
} from "../src/calculation-review.js";
import type { ReviewSource } from "../src/assertion-review.js";
import { reviewUnits } from "../src/assertion-review.js";
import { config, ROOT } from "../src/config.js";
import { Store } from "../src/storage.js";
import { Runtime } from "../src/runtime.js";
import { Knowledge } from "../src/retrieval.js";
import { loadDataset } from "../src/data.js";
import type { ModelProvider, ModelReply } from "../src/contracts.js";
import { ReviewEvidenceRead } from "../src/review-evidence.js";
import { deepseekStrictSchema } from "../src/provider-request.js";
import { z } from "zod";

function source(categoryId = "qa-junior"): ReviewSource {
  const e = calculationEvidence({
    runId: "r",
    executionId: "match",
    role: "match",
    constraintVersion: 1,
    datasetVersion: "d",
    knowledgeHash: "k",
    tool: "jobs_search",
    arguments: { query: '成都 "测试" 😀', categoryIds: [categoryId] },
    result: {
      appliedConstraints: { cities: ["成都"] },
      counts: { beforeFilter: 4, eligible: 1, unknown: 0 },
      categoryCoverage: [
        {
          categoryId,
          totalInSelectedCorpus: 4,
          matchingCity: 1,
          eligible: 1,
          uncertain: 0,
          excludedByHardConditions: 3,
          exclusionCounts: { city: 3, salary: 0 },
        },
      ],
      dataScope: "公开合成快照",
    },
  });
  return {
    id: categoryId,
    kind: "calculation",
    text: e.text,
    origin: { sourceId: e.id, version: e.version, artifactId: "a" },
  };
}
const supported = [{ unitIds: [0], verdict: "supported" }];
function categorySource(cityMatches: number[]): ReviewSource {
  const original = source(),
    body = JSON.parse(original.text);
  body.arguments.categoryIds = cityMatches.map((_, i) => `category-${i}`);
  body.result.counts.beforeFilter = cityMatches.length * 4;
  const row = body.result.categoryCoverage[0];
  body.result.categoryCoverage = cityMatches.map((value, i) => ({
    ...row,
    categoryId: `category-${i}`,
    matchingCity: value,
  }));
  const e = calculationEvidence(body);
  return {
    ...original,
    id: "many",
    text: e.text,
    origin: { ...original.origin!, sourceId: e.id, version: e.version },
  };
}

test("category length and every-category claims use explicit deterministic operations over the fully read array", () => {
  const s = categorySource([1, 1]),
    draft =
      "所选 2 个类别共 8 条岗位；每类别仅 1 条命中成都，其余 3 条被 city 排除（城市约束）。";
  const candidates = countCandidates(reviewUnits(draft));
  assert.deepEqual(
    candidates.map((c) => c.metric),
    ["categorycount", "total", "all:matchingcity", "all:exclusion:city"],
  );
  const facts = calculationFacts([s], [s], candidates);
  const length = facts.find((f) => f.operation === "length")!;
  assert.equal(length.value, 2);
  assert.equal(length.pointer, "/result/categoryCoverage");
  const all = facts.find(
    (f) => f.operation === "all_equal" && f.pointer.endsWith("/matchingCity"),
  )!;
  assert.equal(all.value, 1);
  assert.deepEqual(all.scope.quantifiedCategoryIds, [
    "category-0",
    "category-1",
  ]);
  const claims = candidates.map((c) => ({
    candidateId: c.id,
    factId: (c.metric === "categorycount"
      ? length
      : c.metric === "total"
        ? facts.find((f) => f.pointer === "/result/counts/beforeFilter")!
        : c.metric === "all:matchingcity"
          ? all
          : facts.find(
              (f) =>
                f.operation === "all_equal" &&
                f.pointer.endsWith("/exclusionCounts/city"),
            )!
    ).id,
  }));
  assert.equal(
    validateCalculationClaims(draft, claims, supported, [s], [s]).length,
    4,
  );
  const scalar = facts.find(
    (f) => f.pointer === "/result/categoryCoverage/0/matchingCity",
  );
  assert.equal(
    scalar,
    undefined,
    "A single row is not offered as proof of every row",
  );
});

test("heterogeneous or empty arrays cannot establish an every-category value, and partial reads cannot establish length", () => {
  const draft = "城市筛选：每类别仅 1 条命中成都。",
    c = countCandidates(reviewUnits(draft));
  for (const s of [categorySource([1, 2]), categorySource([])])
    assert.equal(
      calculationFacts([s], [s], c).filter((f) => f.operation === "all_equal")
        .length,
      0,
    );
  const s = categorySource([1, 1]),
    lengthCandidates = countCandidates(reviewUnits("所选 2 个类别的语料。"));
  const cut = s.text.indexOf('"categoryCoverage"');
  const partial = {
    ...s,
    id: `many@0:${cut}`,
    text: s.text.slice(0, cut),
    window: { parentId: "many", start: 0, end: cut, total: s.text.length },
  };
  assert.equal(calculationFacts([partial], [s], lengthCandidates).length, 0);
});
const claimsFor = (draft: string, sources: ReviewSource[]) => {
  const candidates = countCandidates(reviewUnits(draft)),
    facts = calculationFacts(sources, sources, candidates);
  return candidates.map((c) => ({
    candidateId: c.id,
    factId: facts.find(
      (f) =>
        f.value === c.value &&
        (c.metric === "total"
          ? f.pointer.endsWith("/totalInSelectedCorpus")
          : c.metric === "exclusion:city"
            ? f.pointer.endsWith("/exclusionCounts/city")
            : f.pointer.toLowerCase().endsWith("/" + c.metric)),
    )!.id,
  }));
};
test("count guards cover direct field and scoped Chinese counts without treating personal years or action durations as corpus counts", () => {
  const draft =
    "qa-junior 合成语料共 4 条，成都匹配 1 条、合格 1 条，3 条因城市不符排除。";
  const candidates = countCandidates(reviewUnits(draft));
  assert.deepEqual(
    candidates.map((c) => [c.value, c.metric]),
    [
      [4, "total"],
      [1, "matchingcity"],
      [1, "eligible"],
      [3, "exclusion:city"],
    ],
  );
  for (const c of candidates)
    assert.equal(c.text, reviewUnits(draft)[0]!.text.slice(c.start, c.end));
  assert.equal(
    countCandidates(reviewUnits("本科，0年经验；建议3周内完成2个项目。"))
      .length,
    0,
  );
  assert.deepEqual(
    countCandidates(
      reviewUnits("beforeFilter=24，eligible=0，uncertain=0。"),
    ).map((c) => c.metric),
    ["beforefilter", "eligible", "uncertain"],
  );
  assert.equal(
    validateCalculationClaims(
      draft,
      claimsFor(draft, [source()]),
      supported,
      [source()],
      [source()],
    ).length,
    4,
  );
});
test("scope and field bytes must actually be read; forged versions and disjoint gaps cannot create facts", () => {
  assert.deepEqual(
    countCandidates([
      {
        id: 0,
        text: "beforeFilter=-4，eligible=1.5，unknown=50%，returnedCount=1,000",
      },
    ]).map((c) => [c.value, c.metric]),
    [
      [-4, "beforefilter"],
      [1.5, "eligible"],
      [50, "ratio:unknown"],
      [1000, "returnedcount"],
    ],
  );
  const s = source(),
    draft = "beforeFilter=4。",
    c = countCandidates(reviewUnits(draft));
  const start = s.text.indexOf('"counts"'),
    end = start + 55;
  const partial = {
    ...s,
    id: `${s.id}@${start}:${end}`,
    text: s.text.slice(start, end),
    window: { parentId: s.id, start, end, total: s.text.length },
  };
  assert.equal(calculationFacts([partial], [s], c).length, 0);
  const headerEnd = s.text.indexOf('"counts"');
  const withGap = [
    {
      ...s,
      id: `${s.id}@0:${headerEnd}`,
      text: s.text.slice(0, headerEnd),
      window: {
        parentId: s.id,
        start: 0,
        end: headerEnd,
        total: s.text.length,
      },
    },
    partial,
  ];
  assert.equal(calculationFacts(withGap, [s], c).length, 0); // dataScope was never read.
  const facts = calculationFacts([s], [s], c);
  assert.equal(facts.length, 1);
  assert.equal(
    s.text.slice(facts[0]!.fieldRange.start, facts[0]!.fieldRange.end),
    '"beforeFilter":4',
  );
  assert.equal(
    calculationFacts(
      [{ ...s, origin: { ...s.origin!, version: "wrong" } }],
      [s],
      c,
    ).length,
    0,
  );
  assert.equal(
    calculationFacts(
      [{ ...s, text: s.text.replace('"beforeFilter":4', '"beforeFilter":9') }],
      [s],
      c,
    ).length,
    0,
  );
});
test("calculation binding refuses summary-only support, wrong fields, wrong numbers, foreign candidates and duplicates", () => {
  const s = source(),
    draft = "beforeFilter=4。",
    claims = claimsFor(draft, [s]);
  assert.throws(
    () => validateCalculationClaims(draft, [], supported, [], [s]),
    /calculation_evidence_required/,
  );
  assert.throws(
    () => validateCalculationClaims(draft, claims, supported, [], [s]),
    /unread/,
  );
  assert.throws(
    () =>
      validateCalculationClaims(
        draft,
        [...claims, ...claims],
        supported,
        [s],
        [s],
      ),
    /duplicate/,
  );
  assert.throws(
    () =>
      validateCalculationClaims(
        draft,
        [{ ...claims[0]!, candidateId: "another-part" }],
        supported,
        [s],
        [s],
      ),
    /foreign/,
  );
  const changed = "beforeFilter=9。",
    wrong = countCandidates(reviewUnits(changed))[0]!;
  assert.throws(
    () =>
      validateCalculationClaims(
        changed,
        [{ candidateId: wrong.id, factId: claims[0]!.factId }],
        supported,
        [s],
        [s],
      ),
    /value mismatch/,
  );
  const other = "beforeFilter=1，eligible=1。",
    c = countCandidates(reviewUnits(other)),
    f = calculationFacts([s], [s], c);
  assert.throws(
    () =>
      validateCalculationClaims(
        other,
        [
          {
            candidateId: c[0]!.id,
            factId: f.find((x) => x.pointer === "/result/counts/eligible")!.id,
          },
        ],
        supported,
        [s],
        [s],
      ),
    /field\/value mismatch/,
  );
  assert.deepEqual(
    validateCalculationClaims(
      draft,
      [],
      [{ unitIds: [0], verdict: "unsupported" }],
      [],
      [s],
    ),
    [],
  );
});
test("same numeric value in a different explicit category is not valid scope evidence", () => {
  const qa = source(),
    frontend = source("frontend-junior"),
    draft = "qa-junior 合成语料共 4 条。";
  const claim = claimsFor(draft, [frontend]);
  assert.throws(
    () =>
      validateCalculationClaims(
        draft,
        claim,
        supported,
        [qa, frontend],
        [qa, frontend],
      ),
    /category scope mismatch/,
  );
  assert.doesNotThrow(() =>
    deepseekStrictSchema(z.toJSONSchema(ReviewEvidenceRead)),
  );
});

for (const architecture of ["multi-agent", "skills"] as const)
  test(`${architecture}: rejected summary-grounded count triggers actual bounded source read and a bound resubmission`, async () => {
    const store = new Store(":memory:"),
      data = loadDataset(resolve(ROOT, "data/synthetic/dataset.json"));
    const call = (name: string, input: unknown): ModelReply => ({
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: name,
            type: "function",
            function: { name, arguments: JSON.stringify(input) },
          },
        ],
      },
      usage: { input: 10, output: 10, cachedInput: 0 },
      finishReason: "tool_calls",
    });
    let expertCalls = 0;
    const provider: ModelProvider = {
      mode: "replay",
      model: "calculation-binding-fixture",
      async complete(messages, tools) {
        if (tools.some((t) => t.function.name === "plan_submit"))
          return call("plan_submit", {
            rationale: "仅匹配",
            steps: [
              {
                id: "match",
                expert: "match",
                objective: "查询",
                dependsOn: [],
              },
            ],
          });
        if (tools.some((t) => t.function.name === "expert_finish")) {
          if (expertCalls++ === 0)
            return call("jobs_search", {
              query: "岗位",
              categoryIds: [],
              limit: 10,
            });
          const output = JSON.parse(
            messages.findLast((m) => m.role === "tool")!.content!,
          );
          return call("expert_finish", {
            status: "partial",
            summary: "没有合格候选",
            evidenceIds: [output.evidence.id],
            unknowns: [],
            conflicts: [],
            nextActions: [],
            artifact: { rankedJobs: [] },
          });
        }
        if (!tools.some((t) => t.function.name === "final_review_submit"))
          return {
            message: {
              role: "assistant",
              content: "本次检索 beforeFilter=24，eligible=0。",
            },
            usage: { input: 10, output: 10, cachedInput: 0 },
            finishReason: "stop",
          };
        const payload = JSON.parse(messages[1]!.content!);
        if (messages.length > 2 && !payload.evidenceRead.history.length) {
          assert(
            messages.at(-1)!.content!.includes("calculation_evidence_required"),
          );
          return call("final_evidence_read", {
            requests: [
              {
                sourceId: payload.sourceDirectory.find(
                  (s: any) => s.kind === "calculation",
                ).sourceId,
                offset: 0,
                maxChars: 6000,
              },
            ],
          });
        }
        const bindings = payload.evidenceRead.history.length
          ? payload.calculationCandidates.map((c: any) => ({
              candidateId: c.id,
              factId: payload.calculationFacts.find(
                (f: any) =>
                  f.pointer ===
                  (c.metric === "beforefilter"
                    ? "/result/counts/beforeFilter"
                    : "/result/counts/eligible"),
              ).id,
            }))
          : [];
        const evidence =
          payload.sources.find((s: any) => s.kind === "calculation") ??
          payload.sources.find((s: any) => s.kind === "artifact");
        return call("final_review_submit", {
          factsHash: payload.facts.factsHash,
          units: payload.units.map((u: any) => ({
            unitIds: [u.id],
            kind: "execution",
            verdict: "supported",
            evidenceIds: [evidence.fragments[0].id],
            reason: "",
          })),
          changes: [],
          hardConditionCounts: [],
          calculationClaims: bindings,
          extracted: {
            expertCount: null,
            steps: [],
            salaryFilter: null,
            recruitment: null,
          },
          issues: [],
        });
      },
    };
    try {
      const rt = new Runtime(store, new Knowledge(data), provider, {
        ...config(),
        finalReview: "model",
      });
      const run = rt.create({
        userId: "calc-review",
        conversationId: "c",
        request: "查找岗位",
        constraints: { minMonthlySalary: 90000 },
        architecture,
      });
      const done = await rt.execute(run.id, run.request.userId);
      assert.equal(
        done.finalReview?.status,
        "model_checked",
        done.finalReview?.reason,
      );
      const receipt = store.cache(run.id, "final:part:0:0") as any;
      assert.equal(receipt.calculationBindings.length, 2);
      assert(store.cache(run.id, "final:part:0:0:evidence:0"));
      assert.equal(store.modelCalls(run.id).length, 7);
    } finally {
      store.close();
    }
  });
