import test from "node:test";
import assert from "node:assert/strict";
import { calculationEvidence } from "../src/calculation.js";
import {
  calculationFacts,
  countCandidates,
  validateCalculationClaims,
} from "../src/calculation-review.js";
import { reviewUnits, type ReviewSource } from "../src/assertion-review.js";

function graph(start: string, target?: string, maxDepth = 3): ReviewSource {
  const e = calculationEvidence({
    runId: "r",
    executionId: "path",
    role: "path",
    constraintVersion: 1,
    datasetVersion: "d",
    knowledgeHash: "k",
    tool: "graph_paths",
    arguments: { start, ...(target ? { target } : {}), maxDepth },
    result: {
      mode: "balanced",
      returnedRoutes: [],
      returnedCount: 0,
      scope: "Bounded routes in this snapshot and depth",
    },
  });
  return {
    id: e.id,
    kind: "calculation",
    text: e.text,
    origin: { sourceId: e.id, version: e.version, artifactId: "a" },
  };
}
function job(): ReviewSource {
  const e = calculationEvidence({
    runId: "r",
    executionId: "match",
    role: "match",
    constraintVersion: 1,
    datasetVersion: "d",
    knowledgeHash: "k",
    tool: "jobs_search",
    arguments: { query: "qa", categoryIds: ["qa-junior"] },
    result: {
      counts: { eligible: 0 },
      categoryCoverage: [{ categoryId: "qa-junior", eligible: 0 }],
    },
  });
  return {
    id: e.id,
    kind: "calculation",
    text: e.text,
    origin: { sourceId: e.id, version: e.version, artifactId: "a" },
  };
}
function validate(
  draft: string,
  source: ReviewSource,
  universe = [source],
  selected = [source],
) {
  const candidates = countCandidates(reviewUnits(draft));
  assert.equal(candidates.length, 1);
  const fact = calculationFacts([source], universe, candidates).find(
    (f) => f.pointer === "/result/returnedCount",
  )!;
  assert(fact);
  return validateCalculationClaims(
    draft,
    [{ candidateId: candidates[0]!.id, factId: fact.id }],
    [{ unitIds: [0], verdict: "supported" }],
    selected,
    universe,
  );
}

test("bounded graph zero result binds actual origin even when jobs category metadata is also present", () => {
  const g = graph("qa-junior"),
    j = job();
  const draft =
    "- **qa-junior 起点**：本快照本深度未返回任何边（returnedCount=0），不等于现实中不存在测试方向晋升路径。";
  assert.equal(validate(draft, g, [g, j]).length, 1);
  assert.equal(
    validate(draft, g, [g]).length,
    1,
    "graph-only source universe must recognize its own query categories",
  );
  assert.equal(
    validate("起点 qa-junior，本次深度3的返回数 returnedCount=0。", g).length,
    1,
  );
});

test("graph query bindings reject wrong origins, reversed endpoints, wrong targets, depth and broader category sets", () => {
  const g = graph("qa-junior"),
    other = graph("frontend-junior");
  assert.throws(
    () => validate("qa-junior 起点：returnedCount=0。", other, [g, other]),
    /category scope mismatch/,
  );
  assert.throws(
    () =>
      validate("qa-junior、frontend-junior 所有起点：returnedCount=0。", g, [
        g,
        other,
      ]),
    /category scope mismatch/,
  );
  const target = graph("frontend-junior", "qa-junior");
  assert.equal(
    validate(
      "起点 frontend-junior，目标 qa-junior，maxDepth=3，本次 returnedCount=0。",
      target,
    ).length,
    1,
  );
  assert.equal(
    validate("frontend-junior → qa-junior，本次深度3 returnedCount=0。", target)
      .length,
    1,
  );
  assert.throws(
    () =>
      validate(
        "起点 qa-junior，目标 frontend-junior：returnedCount=0。",
        target,
      ),
    /graph query scope mismatch/,
  );
  assert.throws(
    () => validate("qa-junior → frontend-junior：returnedCount=0。", target),
    /graph query scope mismatch/,
  );
  assert.throws(
    () => validate("frontend-junior → qa-senior：returnedCount=0。", target),
    /category scope mismatch/,
  );
  assert.throws(
    () =>
      validate(
        "frontend-junior → qa-junior，maxDepth=5：returnedCount=0。",
        target,
      ),
    /graph query scope mismatch/,
  );
  assert.throws(
    () =>
      validate("起点 frontend-junior，本图全部目标 returnedCount=0。", target),
    /category scope mismatch/,
  );
  assert.throws(
    () => validate("目标 qa-junior：returnedCount=0。", g),
    /graph query scope mismatch/,
  );
});

test("graph counts still require actually read matching source and metric; jobs zero cannot serve as a graph receipt", () => {
  const g = graph("qa-junior"),
    j = job(),
    draft = "qa-junior 起点：returnedCount=0。";
  assert.throws(() => validate(draft, g, [g, j], [j]), /Invalid, unread/);
  const candidate = countCandidates(reviewUnits(draft))[0]!;
  const jobsCandidate = countCandidates(reviewUnits("qa-junior eligible=0。"));
  const fact = calculationFacts([j], [j], jobsCandidate)[0]!;
  assert.throws(
    () =>
      validateCalculationClaims(
        draft,
        [{ candidateId: candidate.id, factId: fact.id }],
        [{ unitIds: [0], verdict: "supported" }],
        [g, j],
        [g, j],
      ),
    /Invalid, unread|field\/value mismatch/,
  );
});
