import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import {
  inspectGlobal,
  planReview,
  GlobalInspection,
} from "../src/review-plan.js";
import {
  AssertionAudit,
  inspectAssertions,
  allowsQuestionClassification,
  allowsEvidenceStatusClassification,
  reviewUnits,
} from "../src/assertion-review.js";
import { deepseekStrictSchema } from "../src/provider-request.js";
import { z } from "zod";
import { Store } from "../src/storage.js";
import { Runtime } from "../src/runtime.js";
import { config, ROOT } from "../src/config.js";
import { Knowledge } from "../src/retrieval.js";
import { loadDataset } from "../src/data.js";
import { segmentedProvider } from "./fixtures/segmented-review-provider.js";
import { reviewProvider } from "./fixtures/final-review-provider.js";
import { finalFacts } from "../src/final-review.js";
import {
  Request,
  type ModelReply,
  type ModelProvider,
} from "../src/contracts.js";

test("input control facts distinguish empty material from personal absence and count UTF-16 explicitly", () => {
  const request = Request.parse({
    userId: "u",
    conversationId: "c",
    request: "画像",
    resumeText: "",
  });
  const empty = finalFacts(request, [], "synthetic");
  assert.equal(empty.inputState.resumeProvided, false);
  assert.equal(empty.inputState.resumeUtf16Length, 0);
  assert.match(empty.inputState.rule, /never absence/);
  assert.equal(
    finalFacts({ ...request, resumeText: "😀" }, [], "synthetic").inputState
      .resumeUtf16Length,
    2,
  );
});

for (const architecture of ["multi-agent", "skills"] as const)
  for (const invalid of ["question", "primary-source"] as const)
    test(`${architecture}: invalid ${invalid} review submission is corrected in the bounded protocol without rewriting the answer`, async () => {
      const store = new Store(":memory:"),
        base = reviewProvider();
      let reviews = 0;
      const answer = "你目前没有企业实习经历。";
      const provider: ModelProvider = {
        ...base,
        async complete(messages, tools, signal) {
          if (
            tools.some((t) =>
              ["plan_submit", "expert_finish"].includes(t.function.name),
            )
          )
            return base.complete(messages, tools, signal);
          if (!tools.some((t) => t.function.name === "final_review_submit"))
            return {
              message: { role: "assistant", content: answer },
              usage: { input: 10, output: 10, cachedInput: 0 },
              finishReason: "stop",
            };
          const payload = JSON.parse(messages[1]!.content!);
          reviews++;
          if (reviews === 2)
            assert(
              messages
                .at(-1)!
                .content!.includes("review_classification_invalid"),
            );
          const args = {
            factsHash: payload.facts.factsHash,
            units: [
              {
                unitIds: [0],
                kind:
                  reviews === 1 && invalid === "question"
                    ? "question"
                    : "personal",
                verdict:
                  reviews === 1 && invalid === "question"
                    ? "nonfactual"
                    : "supported",
                evidenceIds:
                  reviews === 1
                    ? invalid === "question"
                      ? []
                      : [
                          payload.sources.find((s: any) => s.id === "facts")
                            .fragments[0].id,
                        ]
                    : [
                        payload.sources.find((s: any) => s.id === "resume")
                          .fragments[0].id,
                      ],
                reason: "fixture",
              },
            ],
            changes: [],
            hardConditionCounts: [],
            calculationClaims: [],
            extracted: {
              expertCount: null,
              steps: [],
              salaryFilter: null,
              recruitment: null,
            },
            issues: [],
          };
          return {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: `review-${reviews}`,
                  type: "function",
                  function: {
                    name: "final_review_submit",
                    arguments: JSON.stringify(args),
                  },
                },
              ],
            },
            usage: { input: 10, output: 10, cachedInput: 0 },
            finishReason: "tool_calls",
          } satisfies ModelReply;
        },
      };
      try {
        const rt = new Runtime(
          store,
          new Knowledge(
            loadDataset(resolve(ROOT, "data/synthetic/dataset.json")),
          ),
          provider,
          { ...config(), finalReview: "model" },
        );
        const run = rt.create({
          userId: "review-reclass",
          conversationId: "c",
          request: "画像",
          resumeText: "我目前没有企业实习经历。",
          architecture,
        });
        const result = await rt.execute(run.id, run.request.userId);
        assert.equal(result.answer, answer);
        assert.equal(result.finalReview?.status, "model_checked");
        assert.equal(result.finalReview?.revisions, 0);
        assert.equal(reviews, 2);
        assert(store.cache(run.id, "final:part:0:0:format-error"));
        assert.equal(store.cache(run.id, "final:draft:1"), undefined);
        assert.equal(store.modelCalls(run.id).length, 5);
      } finally {
        store.close();
      }
    });

const draft =
  "语料共4条，其中城市符合1条、合格1条、城市排除3条。\n这不代表真实就业市场的岗位数量。\n明确缺少SQL能力。\nSQL能力未核验，不能判定缺失。";
const plan = planReview(draft, []);
const pair = (relation: "contradiction" | "compatible" | "unresolved") => ({
  firstUnitId: 0,
  secondUnitId: 1,
  relation,
  scope: "当前合成语料与现实市场",
  reason: "Different scopes can coexist",
  incompatibility:
    relation === "contradiction"
      ? "Mutually exclusive fixture statements"
      : null,
});

test("global comparisons preserve compatible explanations without treating them as problems; unresolved and actual conflicts remain visible", () => {
  const compatible = inspectGlobal(
    draft,
    { planHash: plan.planHash, comparisons: [pair("compatible")] },
    plan,
  );
  assert.equal(compatible.inspection.comparisons.length, 1);
  assert.deepEqual(compatible.problems, []);
  const unresolved = inspectGlobal(
    draft,
    { planHash: plan.planHash, comparisons: [pair("unresolved")] },
    plan,
  );
  assert.match(unresolved.problems[0]!, /unresolved/);
  const conflict = inspectGlobal(
    draft,
    {
      planHash: plan.planHash,
      comparisons: [
        {
          ...pair("contradiction"),
          firstUnitId: 2,
          secondUnitId: 3,
          scope: "同一个人的当前SQL能力",
          incompatibility: "一处明确缺少，另一处说尚未核验不能判定缺失",
        },
      ],
    },
    plan,
  );
  assert.equal(conflict.problems.length, 1);
  assert.match(conflict.problems[0]!, /contradiction/);
});

test("global relation protocol rejects conflicting dispositions, self-pairs, duplicate reversed pairs, foreign IDs and legacy issues", () => {
  const run = (comparisons: unknown) =>
    inspectGlobal(draft, { planHash: plan.planHash, comparisons }, plan);
  assert.throws(
    () => run([{ ...pair("compatible"), incompatibility: "contradiction" }]),
    /must agree/,
  );
  assert.throws(
    () => run([{ ...pair("contradiction"), incompatibility: null }]),
    /must agree/,
  );
  assert.throws(
    () => run([{ ...pair("compatible"), secondUnitId: 0 }]),
    /distinct/,
  );
  assert.throws(
    () =>
      run([
        pair("compatible"),
        { ...pair("compatible"), firstUnitId: 1, secondUnitId: 0 },
      ]),
    /nonduplicate/,
  );
  assert.throws(
    () => run([{ ...pair("compatible"), secondUnitId: 999 }]),
    /unknown unit/,
  );
  assert(
    !GlobalInspection.safeParse({ planHash: plan.planHash, issues: [] })
      .success,
  );
  assert.doesNotThrow(() =>
    deepseekStrictSchema(z.toJSONSchema(GlobalInspection)),
  );
});

test("direct questions are not personal absence assertions, but an asserted premise cannot hide as a question", () => {
  for (const text of [
    "- 是否用过接口测试（Postman）或自动化测试框架",
    "- 是否了解测试用例设计方法与缺陷管理工具",
    "是否愿意接受QA方向、是否接受先做前端过渡",
    "请补充学习过程或效果",
    "你有没有参与过企业实习？",
    "你是否愿意接受QA方向？",
    "您是否有企业实习经历？",
    "你有企业实习吗？",
    "2. 你有哪些企业实习、校园项目或个人项目经历？",
    "你具备哪些专业技能",
    "你是应届还是往届？",
    "2. 教育背景：学校 / 专业 / 学历层次 / 起止时间",
    "若有：公司、岗位、起止时间、本人职责、产出；若无请明确说明「无企业实习」",
    "- **P1 目标方向**：你希望投递的岗位方向/行业是什么？",
  ]) {
    assert(allowsQuestionClassification(text), text);
    const audit = AssertionAudit.parse({
      units: reviewUnits(text).map((u) => ({
        unitIds: [u.id],
        kind: "question",
        verdict: "nonfactual",
        citations: [],
        reason: "直接提问",
      })),
      changes: [],
      hardConditionCounts: [],
    });
    assert.deepEqual(inspectAssertions(text, audit, [], 0), []);
  }
  for (const text of [
    "你没有企业实习经历，是否接受QA方向？",
    "你是应届生，是否有实习？",
    "请确认：你没有企业实习经历",
    "是否用过接口测试（你已熟悉Python）",
    "是否使用Python；你熟练使用Java",
  ]) {
    assert(!allowsQuestionClassification(text), text);
    const audit = AssertionAudit.parse({
      units: reviewUnits(text).map((u) => ({
        unitIds: [u.id],
        kind: "question",
        verdict: "nonfactual",
        citations: [],
        reason: "",
      })),
      changes: [],
      hardConditionCounts: [],
    });
    assert.throws(
      () => inspectAssertions(text, audit, [], 0),
      /review_classification_invalid.*asserted personal premise/,
    );
  }
});

test("evidence availability stays factual and requires a source; it cannot convert missing information into missing capability", () => {
  const text = "画像 learning 维度为null，本次尚未核验。";
  assert(allowsEvidenceStatusClassification(text));
  assert(
    allowsEvidenceStatusClassification("薪资门槛未设，无法判定是否满足。"),
  );
  assert(
    allowsEvidenceStatusClassification("| 简历读取 | 简历为空（0 字符） |"),
  );
  assert(allowsEvidenceStatusClassification("**材料完整度=0/12**，不可评估。"));
  assert(
    allowsEvidenceStatusClassification(
      "certificate、learning，以上维度均为null。",
    ),
  );
  for (const bad of [
    "你没有实习经历。",
    "简历未提Python，因此你不会Python。",
    "材料未提供证书，所以没有专业能力。",
  ])
    assert(!allowsEvidenceStatusClassification(bad));
  const source = {
    id: "result:profile",
    kind: "artifact",
    text: '{"scores":{"learning":null}}',
  };
  const audit = AssertionAudit.parse({
    units: [
      {
        unitIds: [0],
        kind: "evidence_status",
        verdict: "supported",
        citations: [{ sourceId: source.id, quote: source.text }],
        reason: "输出状态",
      },
    ],
    changes: [],
    hardConditionCounts: [],
  });
  assert.deepEqual(inspectAssertions(text, audit, [source], 0), []);
  const noSource = structuredClone(audit);
  noSource.units[0]!.citations = [];
  assert.throws(
    () => inspectAssertions(text, noSource, [source], 0),
    /requires an exact source/,
  );
  noSource.units[0]!.verdict = "nonfactual";
  assert(
    inspectAssertions(text, noSource, [source], 0).some((p) =>
      p.includes("cannot bypass"),
    ),
  );
});

test("explanatory headings and negated inferences are not affirmative capability claims", () => {
  for (const text of [
    '特别说明：材料为空 **不等于** 能力为零，也 **不等于** "无企业实习"。',
    "材料不足，因此不能说明能力为零。",
    "材料不足，所以没有证据判断能力。",
    "评分说明：未记录的维度保持null，不表示没有能力。",
    '本次没有任何维度达到"原文明确维度级缺失"的标准，因此**没有使用 0 分**。',
  ])
    assert(allowsEvidenceStatusClassification(text), text);
  for (const text of [
    "简历未提Python，因此你不会Python。",
    "未提供证书，所以没有专业能力。",
    "材料缺失，这就说明能力不足。",
  ])
    assert(!allowsEvidenceStatusClassification(text), text);
});

for (const architecture of ["multi-agent", "skills"] as const)
  for (const relation of ["compatible", "unresolved"] as const)
    test(`${architecture}: ${relation} global disposition affects publication while preserving the full comparison`, async () => {
      const store = new Store(":memory:"),
        base = segmentedProvider();
      const provider = {
        ...base,
        async complete(...args: Parameters<typeof base.complete>) {
          const response = await base.complete(...args);
          if (
            args[1].some((t) => t.function.name === "final_consistency_submit")
          ) {
            const payload = JSON.parse(args[0].at(-1)!.content!);
            response.message.tool_calls![0]!.function.arguments =
              JSON.stringify({
                planHash: payload.planHash,
                comparisons: [pair(relation)],
              });
          }
          return response;
        },
      };
      try {
        const rt = new Runtime(
          store,
          new Knowledge(
            loadDataset(resolve(ROOT, "data/synthetic/dataset.json")),
          ),
          provider,
          { ...config(), finalReview: "model" },
        );
        const run = rt.create({
          userId: "relation-test",
          conversationId: "c",
          request: "画像",
          architecture,
        });
        const result = await rt.execute(run.id, run.request.userId);
        assert.equal(
          result.finalReview?.status,
          relation === "compatible" ? "model_checked" : "withheld",
          result.finalReview?.reason,
        );
        const receipt = store.cache(run.id, "final:global:0") as ReturnType<
          typeof inspectGlobal
        >;
        assert.equal(receipt.inspection.comparisons[0]!.relation, relation);
        assert.equal(
          receipt.problems.length,
          relation === "compatible" ? 0 : 1,
        );
        assert.equal(
          store.modelCalls(run.id).length,
          relation === "compatible" ? 7 : 12,
        );
      } finally {
        store.close();
      }
    });
