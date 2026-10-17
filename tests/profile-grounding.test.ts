import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import {
  inspectExplicitAbsence,
  personalContext,
  PROFILE_GROUNDING_VERSION,
} from "../src/profile-grounding.js";
import { Dimensions, Request, type Evidence } from "../src/contracts.js";
import { DomainTools, DomainValidationError } from "../src/tools.js";
import { Runtime } from "../src/runtime.js";
import { Store } from "../src/storage.js";
import { Knowledge } from "../src/retrieval.js";
import { loadDataset } from "../src/data.js";
import { ReplayProvider } from "../src/providers.js";
import { ROOT } from "../src/config.js";
import { config } from "./test-config.js";
import { reviewProvider } from "./fixtures/final-review-provider.js";
import type { ModelProvider, ModelReply } from "../src/contracts.js";

test("absence requires a dimension-wide personal assertion, not missing documentation or a different dimension", () => {
  for (const text of [
    "暂无企业实习经历",
    "我目前没有实习经历",
    "本人从未参加过企业实习",
    "无企业实习，但有校园项目",
    "企业实习经历：无",
    "I have no internship experience.",
  ])
    assert(
      inspectExplicitAbsence("internship", text.replace(/\.$/, ""), text)
        .accepted,
      text,
    );
  for (const text of [
    "本科应届。课程作业使用Vue写过一个表单，没有记录学习过程或效果。",
    "简历未提实习",
    "没有实习记录",
    "未提供实习证明",
    "没有企业实习证明",
    "没有校内实习",
    "没有SQL经验",
    "无CET4证书",
  ])
    assert(
      !inspectExplicitAbsence(
        text.includes("证书") ? "certificate" : "internship",
        text,
        text,
      ).accepted,
      text,
    );
  const examples = {
    professionalSkill: "专业技能",
    certificate: "证书",
    innovation: "创新能力",
    internalMotivation: "内驱力",
    learning: "学习能力",
    stressTolerance: "抗压能力",
    communication: "沟通能力",
    internship: "企业实习",
    language: "外语能力",
    leadership: "领导经历",
    adaptability: "适应能力",
    execution: "执行能力",
  };
  for (const dimension of Dimensions) {
    const text = `我没有${examples[dimension]}`;
    assert(inspectExplicitAbsence(dimension, text, text).accepted);
    for (const other of Dimensions.filter((d) => d !== dimension))
      assert(
        !inspectExplicitAbsence(other, text, text).accepted,
        `${dimension} != ${other}`,
      );
  }
});

test("substring quotes cannot erase negation, conditional scope, another subject, examples or time changes", () => {
  const quote = "无企业实习";
  for (const text of [
    "并非无企业实习",
    "不是无企业实习",
    "不能说无企业实习",
    "如果无企业实习，请补充项目",
    "如果未毕业，无企业实习",
    "同学无企业实习",
    "我同学无企业实习",
    "模板：无企业实习",
    "这是模板\n无企业实习",
    "例如，无企业实习",
    "去年无企业实习",
    "以前无企业实习，现在已完成企业实习",
    "无企业实习。后来参加企业实习。",
    "无企业实习。我有一段企业实习经历。",
    "无企业实习？",
    "无企业实习证明",
  ])
    assert(!inspectExplicitAbsence("internship", quote, text).accepted, text);
  assert(
    !inspectExplicitAbsence("internship", "企业实习", "暂无企业实习").accepted,
  );
  assert(!inspectExplicitAbsence("internship", quote, null).accepted);
});

for (const architecture of ["multi-agent", "skills"] as const)
  test(`${architecture}: runtime returns unsupported-basis feedback and saves only corrected scores`, async () => {
    const store = new Store(":memory:"),
      base = reviewProvider();
    const text =
      "本科应届。课程作业使用Vue写过一个表单，没有记录学习过程或效果。";
    const call = (name: string, args: unknown): ModelReply => ({
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: `call-${name}-${turn}`,
            type: "function",
            function: { name, arguments: JSON.stringify(args) },
          },
        ],
      },
      usage: { input: 10, output: 10, cachedInput: 0 },
      finishReason: "tool_calls",
    });
    let turn = 0;
    const provider: ModelProvider = {
      ...base,
      async complete(messages, tools, signal) {
        if (tools.some((t) => t.function.name === "plan_submit"))
          return base.complete(messages, tools, signal);
        if (!tools.some((t) => t.function.name === "expert_finish"))
          return {
            message: { role: "assistant", content: "实习经历未知，请补充。" },
            usage: { input: 10, output: 10, cachedInput: 0 },
            finishReason: "stop",
          };
        turn++;
        if (turn === 1) return call("resume_read", {});
        if (turn === 2)
          return call("profile_score", {
            observations: [
              {
                dimension: "internship",
                level: 0,
                confidence: 1,
                evidenceId: "resume:1",
                quote: text,
                rationale: "未提及",
                basis: "explicit_absence",
              },
            ],
          });
        if (turn === 3) {
          assert(
            messages.some(
              (m) =>
                m.role === "tool" &&
                m.content?.includes('"code":"profile_basis_unsupported"'),
            ),
          );
          return call("profile_score", { observations: [] });
        }
        if (turn === 4)
          return call("expert_finish", finish(allNull(), ["resume:1"]));
        throw Error("Unexpected extra expert call");
      },
    };
    try {
      const rt = new Runtime(
        store,
        new Knowledge(
          loadDataset(resolve(ROOT, "data/synthetic/dataset.json")),
        ),
        provider,
        { ...config(), finalReview: "off" },
      );
      const run = rt.create({
        userId: "runtime-grounding",
        conversationId: "c",
        request: "仅画像",
        resumeText: text,
        architecture,
      });
      const result = await rt.execute(run.id, run.request.userId);
      assert.equal(result.status, "partial");
      assert.equal(
        store.artifacts(run.id)[0]!.result.artifact.scores &&
          (
            store.artifacts(run.id)[0]!.result.artifact.scores as Record<
              string,
              unknown
            >
          ).internship,
        null,
      );
      assert.equal(
        store.events(run.id).filter((e) => e.type === "tool.failed").length,
        1,
      );
      assert.equal(store.modelCalls(run.id).length, 6);
    } finally {
      store.close();
    }
  });

test("current memory value is evaluated without borrowing a negative phrase from old provenance", () => {
  const request = Request.parse({
    userId: "u",
    conversationId: "c",
    request: "画像",
  });
  const e: Evidence = {
    id: "memory:profile:experience:v2",
    sourceId: "m",
    kind: "memory",
    version: "2",
    text: JSON.stringify({
      value: "已完成企业实习",
      originalEvidence: "无企业实习",
    }),
  };
  assert.equal(personalContext(e, request), "已完成企业实习");
  assert(
    !inspectExplicitAbsence(
      "internship",
      "无企业实习",
      personalContext(e, request),
    ).accepted,
  );
  assert.equal(
    personalContext({ ...e, text: '{"value":"无企业实习' }, request),
    null,
  );
  assert(
    inspectExplicitAbsence(
      "internship",
      "无企业实习",
      personalContext(
        { ...e, text: JSON.stringify({ value: "无企业实习" }) },
        request,
      ),
    ).accepted,
  );
});

function setup(resumeText: string) {
  const store = new Store(":memory:"),
    knowledge = new Knowledge(
      loadDataset(resolve(ROOT, "data/synthetic/dataset.json")),
    );
  const run = new Runtime(
    store,
    knowledge,
    new ReplayProvider([]),
    config(),
  ).create(
    Request.parse({
      userId: "profile-guard",
      conversationId: "c",
      request: "画像",
      resumeText,
    }),
  );
  const tool = new DomainTools(
    "profile",
    run,
    "profile",
    store,
    knowledge,
    [],
    new AbortController().signal,
  );
  return { store, knowledge, run, tool };
}
const allNull = () => Object.fromEntries(Dimensions.map((d) => [d, null]));
const finish = (
  scores: Record<string, number | null>,
  evidenceIds: string[] = [],
) => ({
  status: "needs_input",
  summary: "补充材料",
  evidenceIds,
  unknowns: ["实习经历"],
  conflicts: [],
  nextActions: ["请补充经历"],
  artifact: { scores, skills: [], evidence: [] },
});

test("actual bad zero is rejected atomically with actionable feedback, then null submission and restoration succeed", async () => {
  const text =
    "本科应届。课程作业使用Vue写过一个表单，没有记录学习过程或效果。";
  const { store, knowledge, run, tool } = setup(text);
  try {
    await tool.invoke("resume_read", {}, "read");
    const observed = {
      dimension: "internship",
      level: 0,
      confidence: 0.6,
      evidenceId: "resume:1",
      quote: text,
      rationale: "没有写实习，所以没有实习",
      basis: "explicit_absence",
    };
    await assert.rejects(
      tool.invoke("profile_score", { observations: [observed] }, "bad-score"),
      (e: unknown) =>
        e instanceof DomainValidationError &&
        e.feedback.code === "profile_basis_unsupported",
    );
    await assert.rejects(
      tool.invoke(
        "expert_finish",
        finish({ ...allNull(), internship: 0 }, ["resume:1"]),
        "bypass",
      ),
      /profile_score/,
    );
    const scored: any = await tool.invoke(
      "profile_score",
      {
        observations: [
          {
            ...observed,
            level: null,
            basis: "behavior",
            rationale: "材料不足",
          },
        ],
      },
      "corrected",
    );
    assert.equal(scored.groundingVersion, PROFILE_GROUNDING_VERSION);
    assert.deepEqual(scored.absenceChecks, []);
    assert.equal(scored.scores.internship, null);
    const restored = new DomainTools(
      "profile",
      run,
      "profile",
      store,
      knowledge,
      [],
      new AbortController().signal,
    );
    restored.remember([...tool.seen.values()]);
    restored.remember(scored);
    await restored.invoke(
      "expert_finish",
      finish(scored.scores, ["resume:1"]),
      "done",
    );
    assert.equal(
      (restored.result?.artifact.scores as Record<string, unknown>).internship,
      null,
    );
  } finally {
    store.close();
  }
});

test("explicit zero has a versioned basis receipt and needs_input cannot bypass score validation", async () => {
  const { store, tool } = setup("暂无企业实习经历。");
  try {
    await tool.invoke("resume_read", {}, "read");
    const scored: any = await tool.invoke(
      "profile_score",
      {
        observations: [
          {
            dimension: "internship",
            level: 0,
            confidence: 1,
            evidenceId: "resume:1",
            quote: "暂无企业实习经历",
            rationale: "本人当前自述",
            basis: "explicit_absence",
          },
        ],
      },
      "score",
    );
    assert.equal(scored.scores.internship, 0);
    assert.equal(scored.absenceChecks[0].statement, "暂无企业实习经历");
    await assert.rejects(
      tool.invoke(
        "expert_finish",
        finish({ ...scored.scores, learning: 100 }, ["resume:1"]),
        "fabricated",
      ),
      /profile_score/,
    );
    await tool.invoke(
      "expert_finish",
      finish(scored.scores, ["resume:1"]),
      "finish",
    );
  } finally {
    store.close();
  }
  const empty = setup("");
  try {
    await empty.tool.invoke("expert_finish", finish(allNull()), "empty");
    assert.equal(empty.tool.result?.status, "needs_input");
  } finally {
    empty.store.close();
  }
});
