import test from "node:test";
import assert from "node:assert/strict";
import { Request, type Artifact, type Job } from "../src/contracts.js";
import { finalFacts } from "../src/final-review.js";
import { jobConstraintCheck } from "../src/retrieval.js";
import {
  AssertionAudit,
  inspectAssertions,
  reviewSources,
  resolveCitation,
  reviewUnits,
} from "../src/assertion-review.js";

const request = Request.parse({
  userId: "u",
  conversationId: "c",
  request: "请分析",
  resumeText: "为表单编写测试；与两名同学协作整理需求。暂无企业实习经历。",
  constraints: {
    cities: ["成都"],
    education: "本科",
    experienceYears: 0,
    weekendsOff: true,
    skills: ["Vue"],
  },
});
const facts = finalFacts(request, [], "synthetic");
const sources = reviewSources(request, [], facts, []);
function audit(draft: string) {
  return AssertionAudit.parse({
    units: reviewUnits(draft).map((u) => ({
      unitIds: [u.id],
      kind: "presentation",
      verdict: "nonfactual",
      citations: [],
      reason: "",
    })),
    changes: [],
    hardConditionCounts: [],
  });
}
test("assertion coverage includes Chinese clauses, Markdown, CRLF and astral characters without invented offsets", () => {
  const draft = "## 结果\r\n- 已有测试🙂。是否改城市？\n|条件|结果|\n  ";
  const units = reviewUnits(draft);
  assert.equal(units.length, 4);
  for (const u of units) assert.equal(draft.slice(u.start, u.end), u.text);
  const good = audit(draft);
  assert.deepEqual(inspectAssertions(draft, good, sources, 4), []);
  for (const ids of [
    [0, 1, 3],
    [0, 1, 1, 3],
    [0, 1, 2, 9],
  ]) {
    const bad = {
      ...good,
      units: ids.map((id) => ({ ...good.units[0]!, unitId: id })),
    };
    assert.throws(
      () => inspectAssertions(draft, bad, sources, 4),
      /every draft unit/,
    );
  }
});
test("grouped audit shares a basis without omitting or duplicating any unit", () => {
  const draft = "## 画像\n---\n## 下一步";
  const grouped = audit(draft);
  grouped.units = [{ ...grouped.units[0]!, unitIds: [0, 1, 2] }];
  assert.deepEqual(inspectAssertions(draft, grouped, sources, 4), []);
  grouped.units.push({ ...grouped.units[0]!, unitIds: [2] });
  assert.throws(
    () => inspectAssertions(draft, grouped, sources, 4),
    /every draft unit/,
  );
});
test("absence of advanced evidence cannot hide a reviewer-detected contradiction with basic testing and collaboration", () => {
  const draft = "测试与协作均无证据。";
  const review = audit(draft);
  review.units[0] = {
    unitIds: [0],
    kind: "absence",
    verdict: "contradicted",
    citations: [
      { sourceId: "resume", quote: "为表单编写测试；与两名同学协作整理需求" },
    ],
    reason: "基础经历已出现；尚未证明高级深度不等于全部缺失",
  };
  assert.match(
    inspectAssertions(draft, review, sources, 4).join("\n"),
    /基础经历/,
  );
  review.units[0]!.verdict = "nonfactual";
  assert.match(
    inspectAssertions(draft, review, sources, 4).join("\n"),
    /bypass/,
  );
});
test("personal assertions require primary evidence and all citations must exist verbatim", () => {
  const draft = "有测试经历。";
  const review = audit(draft);
  review.units[0] = {
    unitIds: [0],
    kind: "personal",
    verdict: "supported",
    citations: [{ sourceId: "result:p", quote: "有测试经历" }],
    reason: "",
  };
  const withResult = [
    ...sources,
    { id: "result:p", kind: "artifact", text: "有测试经历" },
  ];
  assert.throws(
    () => inspectAssertions(draft, review, withResult, 4),
    /primary user evidence/,
  );
  review.units[0].citations = [{ sourceId: "resume", quote: "为表单编写测试" }];
  assert.deepEqual(inspectAssertions(draft, review, withResult, 4), []);
  review.units[0].citations = [
    { sourceId: "resume", quote: "主导企业测试平台" },
  ];
  assert.throws(
    () => inspectAssertions(draft, review, withResult, 4),
    /citation absent/,
  );
  review.units[0].citations = [];
  assert.throws(
    () => inspectAssertions(draft, review, withResult, 4),
    /requires an exact/,
  );
});
test("fact relaxation is rejected even when framed as advice; correction and future learning remain allowed", () => {
  const draft = "是否放宽经验与城市条件？";
  const review = audit(draft);
  review.units[0]!.kind = "advice";
  review.changes = [
    { unitId: 0, field: "experienceYears", operation: "relax" },
    { unitId: 0, field: "cities", operation: "relax" },
  ];
  assert.equal(inspectAssertions(draft, review, sources, 4).length, 1);
  for (const field of ["education", "experienceYears", "skills"] as const) {
    for (const operation of ["correct", "develop"] as const) {
      review.changes = [{ unitId: 0, field, operation }];
      assert.deepEqual(inspectAssertions(draft, review, sources, 4), []);
    }
  }
  review.changes = [{ unitId: 6, field: "cities", operation: "relax" }];
  assert.throws(
    () => inspectAssertions(draft, review, sources, 4),
    /unknown unit/,
  );
});
test("hard-filter count agrees with domain checks including zero, false and unrestricted education", () => {
  const job = {
    id: "j",
    city: "成都",
    salaryMin: 5000,
    educationRank: 2,
    experienceMin: 0,
    weekendsOff: true,
  } as Job;
  for (const constraints of [
    {},
    request.constraints,
    {
      experienceYears: 0,
      weekendsOff: false,
      minMonthlySalary: 0,
      education: "不限",
      skills: ["Vue"],
    },
    { cities: ["西安"], education: "硕士", minMonthlySalary: 6000 },
  ]) {
    const r = Request.parse({ ...request, constraints });
    const f = finalFacts(r, [], "synthetic");
    const checks = jobConstraintCheck(job, r.constraints).checks;
    assert.deepEqual(
      f.activeHardConditions,
      checks.filter((c) => c.status !== "not_requested").map((c) => c.field),
    );
  }
  const draft = "五项硬条件全部满足。";
  const review = audit(draft);
  review.hardConditionCounts = [{ unitId: 0, count: 5 }];
  assert.match(
    inspectAssertions(
      draft,
      review,
      sources,
      facts.activeHardConditions.length,
    ).join("\n"),
    /count=4/,
  );
});
test("published evidence pages retain provenance and cannot be joined across an unread gap", () => {
  const artifact = {
    id: "a",
    stepId: "p",
    result: { summary: "审阅" },
    publishedEvidence: [
      {
        sourceId: "job:x",
        version: "v1",
        kind: "job",
        text: "全文含未读部分",
        readTexts: ["前页", "后页"],
      },
    ],
  } as Artifact;
  const published = reviewSources(request, [artifact], facts, []);
  assert(!JSON.stringify(published).includes("全文含未读部分"));
  assert.deepEqual(published.find((s) => s.id === "e1")!.origin, {
    sourceId: "job:x",
    version: "v1",
    artifactId: "a",
  });
  const draft = "该岗位符合。";
  const review = audit(draft);
  review.units[0] = {
    unitIds: [0],
    kind: "qualification",
    verdict: "supported",
    citations: [{ sourceId: "e0", quote: "前页后页" }],
    reason: "",
  };
  assert.throws(
    () => inspectAssertions(draft, review, published, 4),
    /citation absent/,
  );
});
test("identical published artifacts use one source body while retaining provenance", () => {
  const result = { summary: "原始结论", status: "partial" };
  const artifacts = [
    { id: "a", stepId: "p", result },
    {
      id: "b",
      stepId: "m",
      result: { summary: "新结论" },
      publishedEvidence: [
        {
          sourceId: "a",
          version: "1",
          kind: "artifact",
          text: JSON.stringify(result),
        },
      ],
    },
  ] as Artifact[];
  const list = reviewSources(request, artifacts, facts, []);
  assert.equal(list.filter((s) => s.text === JSON.stringify(result)).length, 1);
  assert.deepEqual(list.find((s) => s.id === "result:p")!.alsoPublishedAs, [
    { sourceId: "a", version: "1", artifactId: "b" },
  ]);
});

test("explicit structured applicant constraints are primary user evidence", () => {
  const r = Request.parse({
    ...request,
    resumeText: "",
    request: "请匹配岗位",
    constraints: { education: "硕士", experienceYears: 2 },
  });
  const list = reviewSources(r, [], finalFacts(r, [], "synthetic"), []);
  const draft = "申请人学历为硕士。";
  const inspection = audit(draft);
  inspection.units[0] = {
    unitIds: [0],
    kind: "personal",
    verdict: "supported",
    citations: [{ sourceId: "constraints", quote: '"education":"硕士"' }],
    reason: "",
  };
  assert.deepEqual(inspectAssertions(draft, inspection, list, 2), []);
});

test("JSON-rendered citations resolve exactly one layer without fuzzy matching", () => {
  const source = { id: "s", kind: "request", text: '{"education":"硕士"}' };
  const raw = JSON.stringify(source.text).slice(1, -1);
  assert.deepEqual(resolveCitation(raw, source), {
    quote: source.text,
    representation: "json-escaped",
  });
  assert.equal(resolveCitation(JSON.stringify(raw).slice(1, -1), source), null);
  assert.equal(resolveCitation('{ "education": "硕士" }', source), null);
  assert.equal(resolveCitation('"education":"博士"', source), null);
});
