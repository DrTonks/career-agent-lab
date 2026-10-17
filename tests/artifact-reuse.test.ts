import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { Artifact, Dimensions, ModelReply, Request } from "../src/contracts.js";
import { profileFacts } from "../src/artifact-reuse.js";
import { hash, ROOT } from "../src/config.js";
import { config } from "./test-config.js";
import { Store } from "../src/storage.js";
import { Runtime } from "../src/runtime.js";
import { Knowledge } from "../src/retrieval.js";
import { loadDataset } from "../src/data.js";
import { ReplayProvider } from "../src/providers.js";
const resumeText = "使用 Vue 完成网页项目。";
const a: Artifact = {
  id: "prior:profile",
  runId: "prior",
  stepId: "profile",
  expert: "profile",
  version: 1,
  result: {
    status: "partial",
    summary: "OLD_CITY_ADVICE：只考虑西安",
    evidenceIds: ["resume:1"],
    unknowns: ["旧城市约束"],
    conflicts: [],
    nextActions: ["仅申请西安"],
    artifact: {
      scores: Object.fromEntries(Dimensions.map((d) => [d, 50])),
      skills: ["Vue", "invented skill"],
      evidence: [
        {
          dimension: "professionalSkill",
          evidenceId: "resume:1",
          quote: "Vue",
        },
      ],
      advice: "OLD_CITY_ADVICE",
    },
  },
  publishedEvidence: [
    {
      id: "resume:1",
      sourceId: "input:resume:1",
      kind: "resume",
      text: resumeText,
      version: hash(resumeText),
    },
  ],
};
test("profile reuse strips goal advice and preserves only resume-supported fields with provenance", () => {
  const projected = profileFacts(a, resumeText)!;
  assert.ok(projected);
  assert.equal(projected.reuse!.sourceArtifactId, a.id);
  assert.ok(!JSON.stringify(projected).includes("OLD_CITY_ADVICE"));
  assert.deepEqual(projected.result.artifact.skills, ["Vue"]);
  assert.equal((projected.result.artifact.scores as any).professionalSkill, 50);
  assert.equal((projected.result.artifact.scores as any).communication, null);
  assert.equal(profileFacts(a, "另一份简历"), undefined);
  const mismatch = structuredClone(a);
  mismatch.result.artifact.evidence = [
    {
      dimension: "professionalSkill",
      evidenceId: "resume:1",
      quote: "fabricated quote",
    },
  ];
  const sanitized = profileFacts(mismatch, resumeText)!;
  assert.deepEqual(sanitized.result.artifact.evidence, []);
  assert.equal(
    (sanitized.result.artifact.scores as any).professionalSkill,
    null,
  );
  assert.equal(profileFacts({ ...a, expert: "match" }, resumeText), undefined);
});
test("resume reuse retains published unscored facts without trusting inferred skill labels or stale preferences", () => {
  const text = "使用 Vue 完成网页项目。\n为表单编写测试，修复重复提交。";
  const source = structuredClone(a);
  source.publishedEvidence![0]!.version = hash(text);
  source.publishedEvidence!.push({
    id: "resume:2",
    sourceId: "input:resume:2",
    kind: "resume",
    version: hash(text),
    text: "为表单编写测试，修复重复提交。",
  });
  source.result.artifact.skills = ["Vue", "单元测试（表单测试）"];
  const projected = profileFacts(source, text)!;
  assert.deepEqual(projected.result.artifact.skills, ["Vue"]);
  assert(projected.result.evidenceIds.includes("resume:2"));
  assert(
    JSON.stringify(projected.result.artifact.sourceObservations).includes(
      "为表单编写测试",
    ),
  );
  assert(!JSON.stringify(projected).includes("OLD_CITY_ADVICE"));
  source.publishedEvidence![1]!.version = "stale";
  assert(
    !JSON.stringify(profileFacts(source, text)).includes("为表单编写测试"),
  );
});
function call(name: string, args: unknown): { reply: ModelReply } {
  return {
    reply: {
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: name,
            type: "function",
            function: { name, arguments: JSON.stringify(args) },
          },
        ],
      },
      usage: { input: 10, output: 10, cachedInput: 0 },
      finishReason: "tool_calls",
    },
  };
}
for (const versionChanged of [false, true]) {
  test(`new city retains only eligible profile facts; implementation changed=${versionChanged}`, async () => {
    const s = new Store(":memory:");
    const k = new Knowledge(
      loadDataset(resolve(ROOT, "data/synthetic/dataset.json")),
    );
    const request = Request.parse({
      userId: "reuse",
      conversationId: "c",
      request: "匹配岗位",
      resumeText,
      constraints: { cities: ["西安"] },
    });
    const baseRt = new Runtime(s, k, new ReplayProvider([]), config()),
      prior = baseRt.create(request);
    s.saveArtifact({ ...a, id: `${prior.id}:profile`, runId: prior.id });
    s.saveArtifact({
      ...a,
      id: `${prior.id}:match`,
      runId: prior.id,
      stepId: "match",
      expert: "match",
      result: {
        ...a.result,
        status: "succeeded",
        summary: "STALE_MATCH_CANARY",
      },
    });
    s.update(prior.id, {
      status: "partial",
      ...(versionChanged ? { configHash: "different-implementation" } : {}),
    });
    const replies = [
      call("plan_submit", {
        rationale: "当前约束匹配",
        steps: [
          {
            id: "match",
            expert: "match",
            objective: "成都岗位",
            dependsOn: [],
          },
        ],
      }),
      call("expert_finish", {
        status: "needs_input",
        summary: "需要补充条件",
        evidenceIds: [],
        unknowns: [],
        conflicts: [],
        nextActions: [],
        artifact: {},
      }),
      {
        reply: {
          message: {
            role: "assistant" as const,
            content: "依据当前条件继续。",
          },
          usage: { input: 10, output: 10, cachedInput: 0 },
          finishReason: "stop",
        },
      },
    ];
    try {
      const rt = new Runtime(s, k, new ReplayProvider(replies), config()),
        fresh = rt.create({ ...request, constraints: { cities: ["成都"] } });
      assert.equal(
        (await rt.execute(fresh.id, request.userId)).status,
        "partial",
      );
      const text = JSON.stringify(s.modelCalls(fresh.id));
      assert.ok(!text.includes("STALE_MATCH_CANARY"));
      assert.ok(!text.includes("OLD_CITY_ADVICE"));
      const plannerInput = JSON.parse(
        (
          s.modelCalls(fresh.id)[0]!
            .messages as import("../src/contracts.js").Message[]
        )[1]!.content!,
      );
      assert.equal(
        plannerInput.availablePriorArtifacts.some(
          (p: Artifact) => p.reuse?.policy === "resume-facts-v2",
        ),
        !versionChanged,
      );
      assert.equal(
        s.artifact(fresh.id, "match")!.inputArtifactIds!.length,
        versionChanged ? 0 : 1,
      );
      assert.equal(
        s.artifactHistory(prior.id)[0]!.artifact.result.summary,
        a.result.summary,
      );
    } finally {
      s.close();
    }
  });
}
