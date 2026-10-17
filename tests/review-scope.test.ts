import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { calculationEvidence } from "../src/calculation.js";
import {
  countCandidates,
  calculationFacts,
  validateCalculationClaims,
} from "../src/calculation-review.js";
import {
  classificationGuidance,
  allowsEvidenceStatusClassification,
  allowsQuestionClassification,
  reviewUnits,
  inspectAssertions,
  AssertionAudit,
  type ReviewSource,
} from "../src/assertion-review.js";
import { planReview, partPayload } from "../src/review-plan.js";
import { finalFacts } from "../src/final-review.js";
import { config, ROOT } from "../src/config.js";
import {
  Request,
  type ModelProvider,
  type ModelReply,
} from "../src/contracts.js";
import { Runtime } from "../src/runtime.js";
import { Store } from "../src/storage.js";
import { Knowledge } from "../src/retrieval.js";
import { loadDataset } from "../src/data.js";

const observed = (eligible = 1): ReviewSource => {
  const e = calculationEvidence({
    runId: "r",
    executionId: "match",
    role: "match",
    constraintVersion: 1,
    datasetVersion: "d",
    knowledgeHash: "k",
    tool: "jobs_search",
    arguments: { categoryIds: ["frontend-junior"] },
    result: {
      appliedConstraints: { cities: ["成都"] },
      counts: { beforeFilter: 4, eligible, unknown: 0 },
      dataScope: "synthetic",
    },
  });
  return {
    id: "receipt",
    kind: "calculation",
    text: e.text,
    origin: { sourceId: e.id, version: e.version, artifactId: "a" },
  };
};

test("epistemic negation does not assert its embedded personal claim, while later assertions and double negation remain guarded", () => {
  for (const text of [
    "** 当前既不能确认你具备任何能力，也不能确认你缺少任何能力。",
    "目前无法判断你是否掌握编程。",
    "尚未证明你没有相关经验。",
    "没有充分证据表明你具备领导能力。",
    "根据现有材料不能确认你已经取得证书。",
  ])
    assert(allowsEvidenceStatusClassification(text), text);
  for (const text of [
    "不能确认你具备能力，但你没有实习经历。",
    "目前无法判断你是否掌握编程，因为你没有项目经历。",
    "不能确认你具备能力，所以你能力不足。",
    "你具备专业技能，不过当前无法确认具体程度。",
    "并非不能确认你具备能力。",
    "不是没有证据表明你具备领导能力。",
  ]) {
    assert(!allowsEvidenceStatusClassification(text), text);
  }
  assert(
    !allowsQuestionClassification(
      "无法确认你具备能力，但你没有经验，该怎么补？",
    ),
  );
  assert.equal(
    classificationGuidance(
      reviewUnits("当前既不能确认你具备任何能力，也不能确认你缺少任何能力。"),
    ).length,
    1,
  );
});

test("retrieval qualifiers after a later quantity cannot be assigned to an earlier total or eligible count", () => {
  for (const [text, expected] of [
    [
      "语料4条中3条因城市非成都被排除。",
      [
        [4, "count"],
        [3, "exclusion:city"],
      ],
    ],
    [
      "frontend-mid北京0条合格（4条被experience排除）。",
      [
        [0, "eligible"],
        [4, "exclusion:experience"],
      ],
    ],
    [
      "岗位语料共4条，筛选后1条合格，3条被城市排除。",
      [
        [4, "total"],
        [1, "eligible"],
        [3, "exclusion:city"],
      ],
    ],
  ] as const)
    assert.deepEqual(
      countCandidates(reviewUnits(text)).map((c) => [c.value, c.metric]),
      expected,
      text,
    );
});

test("retrieval count qualifiers distinguish corpus, filtered, uncertain and excluded scopes across clauses", () => {
  const cases: [string, string[]][] = [
    ["在成都+应届+双休硬条件下，合成语料仅 1 条初级前端候选。", ["eligible"]],
    ["在成都约束下，语料共 1 条候选。", ["eligible"]],
    ["满足全部条件的岗位共 1 条。", ["eligible"]],
    ["筛选后共 1 条岗位。", ["eligible"]],
    ["过滤之后共 1 条候选。", ["eligible"]],
    ["筛选前共 4 条岗位，筛选后共 1 条。", ["total", "eligible"]],
    ["筛选后共 1 条候选，筛选前共 4 条。", ["eligible", "total"]],
    ["筛选后共 1 条岗位；语料共 4 条。", ["eligible", "total"]],
    ["在成都硬条件下，语料总计 4 条，合格 1 条。", ["total", "eligible"]],
    ["在成都硬条件下，待核验 1 条候选。", ["uncertain"]],
    ["在成都硬条件下，3 条因城市不符排除。", ["exclusion:city"]],
    ["合成语料仅 1 条候选。", ["count"]],
    [
      "合成语料共 4 条，成都匹配 1 条、合格 1 条。",
      ["total", "matchingcity", "eligible"],
    ],
    ["筛选后 beforeFilter=4，eligible=1。", ["beforefilter", "eligible"]],
  ];
  for (const [text, expected] of cases)
    assert.deepEqual(
      countCandidates(reviewUnits(text)).map((c) => c.metric),
      expected,
      text,
    );
});

test("time quantities in retrieval action rows are not truncated into job counts; adjacent real counts remain", () => {
  for (const text of [
    "| 9–18 个月 | 进阶前端 | 岗位检索与项目补强 |",
    "岗位检索计划持续18个月。",
    "筛选安排在2个星期内，每次1个小时。",
    "检索计划覆盖2个季度、1个学期及3个工作日。",
  ])
    assert.deepEqual(countCandidates(reviewUnits(text)), [], text);
  const mixed = countCandidates(
    reviewUnits("| 9–18 个月 | 筛选后共 2 个候选，待核实 1 条 |"),
  );
  assert.deepEqual(
    mixed.map((c) => [c.value, c.metric]),
    [
      [2, "eligible"],
      [1, "uncertain"],
    ],
  );
});

test("historical conditioned candidate count binds eligible with visible query scope and rejects pre-filter values", () => {
  const s = observed(),
    draft = "在成都+应届+双休硬条件下，合成语料仅 1 条初级前端候选。";
  const candidates = countCandidates(reviewUnits(draft)),
    facts = calculationFacts([s], [s], candidates);
  const fact = facts.find((f) => f.pointer === "/result/counts/eligible")!;
  assert(fact);
  assert.equal(fact.value, 1);
  assert.deepEqual(fact.scope.appliedConstraints, { cities: ["成都"] });
  const bindings = [{ candidateId: candidates[0]!.id, factId: fact.id }];
  assert.doesNotThrow(() =>
    validateCalculationClaims(
      draft,
      bindings,
      [{ unitIds: [0], verdict: "supported" }],
      [s],
      [s],
    ),
  );
  const plan = planReview(draft, [s]);
  const payload = partPayload(
    plan,
    plan.parts[0]!,
    finalFacts(
      Request.parse({ userId: "u", conversationId: "c", request: "规划" }),
      [],
      "synthetic",
    ),
    [s],
  );
  assert.deepEqual(
    payload.calculationScopes.find(
      (s) => s.id === payload.calculationFacts[0]!.scopeId,
    )!.scope.arguments,
    {
      categoryIds: ["frontend-junior"],
    },
  );
  assert.throws(
    () =>
      validateCalculationClaims(
        draft,
        bindings,
        [{ unitIds: [0], verdict: "supported" }],
        [],
        [s],
      ),
    /unread/,
  );
  const wrong = observed(4),
    wrongFact = calculationFacts([wrong], [wrong], candidates)[0]!;
  assert.throws(
    () =>
      validateCalculationClaims(
        draft,
        [{ candidateId: candidates[0]!.id, factId: wrongFact.id }],
        [{ unitIds: [0], verdict: "supported" }],
        [wrong],
        [wrong],
      ),
    /field\/value mismatch/,
  );
});

test("wire calculation scopes are losslessly shared per source without changing factual IDs or granting unseen fields", () => {
  const source = observed(4),
    other = { ...observed(1), id: "other" };
  const text = "筛选前共4条岗位，筛选后共4条，待核实0条。";
  const plan = planReview(text, [source, other], {
    unitsPerPart: 16,
    sourceTokens: 24000,
  });
  const p = partPayload(
    plan,
    plan.parts[0]!,
    finalFacts(
      Request.parse({ userId: "u", conversationId: "c", request: "规划" }),
      [],
      "synthetic",
    ),
    [source, other],
  );
  const raw = calculationFacts(
    plan.parts[0]!.sources,
    [source, other],
    p.calculationCandidates,
  );
  assert(p.calculationScopes.length < p.calculationFacts.length);
  assert.equal(p.calculationScopes.length, 2);
  assert.deepEqual(
    p.calculationFacts.map(({ scopeId, ...f }) => {
      const scope = p.calculationScopes.find((s) => s.id === scopeId)!;
      assert.equal(scope.sourceId, f.sourceId);
      return { ...f, scope: scope.scope };
    }),
    raw.map(({ fieldRange: _, ...f }) => f),
  );
  assert.deepEqual(
    partPayload(
      plan,
      { ...plan.parts[0]!, sources: [] },
      finalFacts(
        Request.parse({ userId: "u", conversationId: "c", request: "规划" }),
        [],
        "synthetic",
      ),
      [source, other],
    ).calculationScopes,
    [],
  );
});

test("explicit total and filtered fields remain distinct even when values coincide", () => {
  const s = observed(4),
    draft = "筛选前共 4 条岗位，筛选后共 4 条。";
  const cs = countCandidates(reviewUnits(draft)),
    fs = calculationFacts([s], [s], cs);
  const total = fs.find((f) => f.pointer.endsWith("beforeFilter"))!,
    eligible = fs.find((f) => f.pointer.endsWith("eligible"))!;
  assert.throws(
    () =>
      validateCalculationClaims(
        draft,
        [
          { candidateId: cs[0]!.id, factId: eligible.id },
          { candidateId: cs[1]!.id, factId: total.id },
        ],
        [{ unitIds: [0], verdict: "supported" }],
        [s],
        [s],
      ),
    /field\/value mismatch/,
  );
});

test("state-classification hints never prove correctness, supply citations or permit personal claims", () => {
  const text = "其余7维证据不足，保留null，未用低分硬推断。";
  const units = reviewUnits(text),
    hint = classificationGuidance(units);
  assert.equal(hint[0]!.candidateKind, "evidence_status");
  assert.equal(
    classificationGuidance(reviewUnits("证据不足，所以你没有专业能力。"))
      .length,
    0,
  );
  assert.equal(
    classificationGuidance(
      reviewUnits("你没有企业实习经历，internship保留null。"),
    ).length,
    0,
  );
  const audit = AssertionAudit.parse({
    units: [
      {
        unitIds: [0],
        kind: "evidence_status",
        verdict: "supported",
        citations: [],
        reason: "hint",
      },
    ],
    changes: [],
    hardConditionCounts: [],
  });
  assert.throws(
    () => inspectAssertions(text, audit, [], 0),
    /requires an exact source/,
  );
  const plan = planReview(text, []),
    facts = finalFacts(
      Request.parse({ userId: "u", conversationId: "c", request: "画像" }),
      [],
      "synthetic",
    );
  assert.deepEqual(
    partPayload(plan, plan.parts[0]!, facts).classificationGuidance,
    hint,
  );
});

test("expert turn setting rejects non-positive/fractional values", () => {
  const old = process.env.CAREER_MAX_EXPERT_TURNS;
  try {
    for (const value of ["0", "-1", "1.5", "NaN"]) {
      process.env.CAREER_MAX_EXPERT_TURNS = value;
      assert.throws(() => config(), /CAREER_MAX_EXPERT_TURNS/);
    }
    process.env.CAREER_MAX_EXPERT_TURNS = "24";
    assert.equal(config().maxTurns, 24);
  } finally {
    if (old === undefined) delete process.env.CAREER_MAX_EXPERT_TURNS;
    else process.env.CAREER_MAX_EXPERT_TURNS = old;
  }
});

for (const architecture of ["multi-agent", "skills"] as const)
  test(`${architecture}: configured long tool loop crosses old graph ceiling, while low turn limit still stops`, async () => {
    for (const maxTurns of [24, 3]) {
      const store = new Store(":memory:");
      let reads = 0;
      const call = (name: string, args: unknown): ModelReply => ({
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: `${name}-${reads}`,
              type: "function",
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        },
        usage: { input: 10, output: 10, cachedInput: 0 },
        finishReason: "tool_calls",
      });
      const provider: ModelProvider = {
        mode: "replay",
        model: "long-tool-loop",
        async complete(_m, tools) {
          if (tools.some((t) => t.function.name === "plan_submit"))
            return call("plan_submit", {
              rationale: "逐页读取",
              steps: [
                {
                  id: "profile",
                  expert: "profile",
                  objective: "读取长材料",
                  dependsOn: [],
                },
              ],
            });
          if (tools.some((t) => t.function.name === "expert_finish")) {
            if (reads < 21)
              return call("input_read", {
                source: "resume",
                offset: reads++ * 300,
                maxChars: 300,
              });
            return call("expert_finish", {
              status: "needs_input",
              summary: "协议测试完成读取",
              evidenceIds: [],
              unknowns: ["需业务材料"],
              conflicts: [],
              nextActions: [],
              artifact: {},
            });
          }
          return {
            message: { role: "assistant", content: "协议完成；不是质量判断" },
            usage: { input: 10, output: 10, cachedInput: 0 },
            finishReason: "stop",
          };
        },
      };
      try {
        const runtime = new Runtime(
          store,
          new Knowledge(
            loadDataset(resolve(ROOT, "data/synthetic/dataset.json")),
          ),
          provider,
          {
            ...config(),
            finalReview: "off",
            maxTurns,
            maxStepAttempts: 1,
            maxCoordinationRounds: 0,
          },
        );
        const r = runtime.create(
          Request.parse({
            userId: "u",
            conversationId: `${architecture}-${maxTurns}`,
            architecture,
            request: "读取长材料",
            resumeText: "材料".repeat(3500),
          }),
        );
        await runtime.execute(r.id, "u");
        const artifact = store.artifact(r.id, "profile")!;
        if (maxTurns === 24) {
          assert.equal(reads, 21);
          assert.equal(artifact.result.status, "needs_input");
          assert(!artifact.failure);
        } else {
          assert.equal(reads, 3);
          assert.equal(artifact.failure?.code, "expert_turn_limit");
        }
      } finally {
        store.close();
      }
    }
  });
