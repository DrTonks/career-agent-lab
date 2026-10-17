import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { resolve } from "node:path";
import {
  Artifact,
  Dimensions,
  ExpertResult,
  MemoryProposal,
  ModelReply,
  Plan,
  Request,
} from "../src/contracts.js";
import { revisePlan, retryFailedStep } from "../src/coordination.js";
import { ROOT } from "../src/config.js";
import { config } from "./test-config.js";
import { loadDataset } from "../src/data.js";
import { Knowledge } from "../src/retrieval.js";
import { ProviderError, ReplayProvider } from "../src/providers.js";
import { classifyFailure, RuntimeLimitError } from "../src/failures.js";
import { Runtime } from "../src/runtime.js";
import { Store } from "../src/storage.js";
import { DomainTools } from "../src/tools.js";

const plan: Plan = {
  rationale: "完整职业规划",
  steps: [
    { id: "profile", expert: "profile", objective: "画像", dependsOn: [] },
    { id: "match", expert: "match", objective: "匹配", dependsOn: ["profile"] },
    { id: "path", expert: "path", objective: "路径", dependsOn: ["match"] },
    {
      id: "report",
      expert: "report",
      objective: "报告",
      dependsOn: ["profile", "match", "path"],
    },
  ],
};
const repaired = structuredClone(plan);
repaired.steps[1]!.objective = "重读岗位来源，确认报告提出的限制";
const base: ExpertResult = {
  status: "needs_input",
  summary: "需补证",
  evidenceIds: [],
  unknowns: [],
  conflicts: [],
  nextActions: [],
  artifact: {},
};
const requestArtifact: Artifact = {
  id: "r:report",
  runId: "r",
  stepId: "report",
  expert: "report",
  version: 1,
  result: {
    ...base,
    collaboration: {
      kind: "evidence",
      targetStepId: "match",
      question: "请补充限制来源",
      evidenceIds: [],
    },
  },
};
const artifacts: Artifact[] = plan.steps.map((s) =>
  s.id === "report"
    ? requestArtifact
    : {
        id: `r:${s.id}`,
        runId: "r",
        stepId: s.id,
        expert: s.expert,
        version: 1,
        result: base,
      },
);
const dataset = loadDataset(resolve(ROOT, "data/synthetic/dataset.json"));
const request = Request.parse({
  userId: "coordination-user",
  conversationId: "conversation",
  request: "完整职业规划",
});
function call(name: string, args: unknown): { reply: ModelReply } {
  return {
    reply: {
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: `call-${name}`,
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
const answer = {
  reply: {
    message: {
      role: "assistant" as const,
      content: "已按修复结果汇总，仍有明确未知项。",
    },
    usage: { input: 10, output: 10, cachedInput: 0 },
    finishReason: "stop",
  },
};
const readRule = (role: string) =>
  call("knowledge_read", { id: `rule:${role}` });
function finish(role: string, summary: string) {
  const artifact =
    role === "profile"
      ? {
          scores: Object.fromEntries(Dimensions.map((d) => [d, null])),
          skills: [],
          evidence: [],
        }
      : role === "match"
        ? { rankedJobs: [] }
        : role === "path"
          ? { paths: [] }
          : {
              markdown: summary,
              claims: [{ text: summary, evidenceIds: ["rule:report"] }],
            };
  return call("expert_finish", {
    ...base,
    status: "partial",
    summary,
    evidenceIds: [`rule:${role}`],
    artifact,
  });
}
const proposal = (namespace: string, value: string) =>
  call("memory_propose", {
    namespace,
    key: "fixture",
    value,
    evidenceIds: [`rule:${namespace}`],
    expectedVersion: 0,
  });

for (const architecture of ["multi-agent", "skills"] as const) {
  test(`${architecture}: a missing expert is added by the coordinator and receives the scoped repair request`, async () => {
    const initial: Plan = {
      rationale: "先审报告",
      steps: [{ ...plan.steps[3]!, dependsOn: [] }],
    };
    const expanded: Plan = {
      rationale: "补入画像",
      steps: [plan.steps[0]!, { ...plan.steps[3]!, dependsOn: ["profile"] }],
    };
    const f = [
      call("plan_submit", initial),
      call("collaboration_request", {
        kind: "assistance",
        targetStepId: null,
        targetRole: "profile",
        question: "MISSING_PROFILE_REQUEST：需要画像来源",
        evidenceIds: [],
      }),
      call("coordination_decide", {
        action: "revise",
        reason: "补入缺失专家",
        targetStepId: "profile",
        plan: expanded,
      }),
      readRule("profile"),
      call("profile_score", { observations: [] }),
      finish("profile", "画像证据不足"),
      readRule("report"),
      finish("report", "依据新增画像说明限制"),
      answer,
    ];
    const s = new Store(":memory:");
    try {
      const rt = new Runtime(
          s,
          new Knowledge(dataset),
          new ReplayProvider(f),
          config(),
        ),
        r = rt.create({ ...request, architecture });
      const done = await rt.execute(r.id, request.userId);
      assert.equal(done.status, "partial", done.error);
      assert.equal(s.artifact(r.id, "profile")!.attempt, 1);
      assert.equal(s.artifact(r.id, "report")!.attempt, 2);
      assert.ok(
        JSON.stringify(
          s.modelCalls(r.id).find((c) => c.role === "profile")!.messages,
        ).includes("MISSING_PROFILE_REQUEST"),
      );
      assert.deepEqual(s.artifact(r.id, "report")!.inputArtifactIds, [
        s.artifact(r.id, "profile")!.id,
      ]);
      assert.equal(
        s.artifactHistory(r.id).filter((h) => h.invalidatedBy).length,
        1,
      );
    } finally {
      s.close();
    }
  });

  test(`${architecture}: transient failure retries only the failed expert and preserves completed profile`, async () => {
    const initial: Plan = {
      rationale: "三个步骤",
      steps: [
        plan.steps[0]!,
        plan.steps[1]!,
        { ...plan.steps[3]!, dependsOn: ["match"] },
      ],
    };
    const replay = new ReplayProvider([
      call("plan_submit", initial),
      readRule("profile"),
      call("profile_score", { observations: [] }),
      finish("profile", "保留画像"),
      readRule("match"),
      finish("match", "重试结果"),
      readRule("report"),
      finish("report", "完成报告"),
      answer,
    ]);
    let failures = 0;
    const provider: import("../src/contracts.js").ModelProvider = {
      mode: "replay",
      model: replay.model,
      async complete(messages, tools, signal, delta) {
        if (
          tools.some((t) => t.function.name === "jobs_search") &&
          failures < 2
        ) {
          failures++;
          throw new ProviderError("temporary upstream unavailable", true, 503);
        }
        return replay.complete(messages, tools, signal, delta);
      },
    };
    const s = new Store(":memory:");
    try {
      const rt = new Runtime(s, new Knowledge(dataset), provider, {
          ...config(),
          concurrency: 1,
        }),
        r = rt.create({ ...request, architecture });
      const done = await rt.execute(r.id, request.userId);
      assert.equal(done.status, "partial", done.error);
      assert.equal(s.artifact(r.id, "profile")!.attempt, 1);
      assert.equal(s.artifact(r.id, "match")!.attempt, 2);
      assert.equal(s.artifact(r.id, "report")!.attempt, 1);
      assert.equal(
        s
          .events(r.id)
          .filter((e) => e.type === "expert.started" && e.expert === "profile")
          .length,
        1,
      );
      const failed = s.artifactHistory(r.id).find((h) => h.artifact.failure)!;
      assert.equal(failed.artifact.failure!.code, "provider_transient");
      assert.ok(failed.invalidatedBy);
      assert.equal(
        s.modelCalls(r.id).filter((c) => c.status === "failed").length,
        2,
      );
      assert.equal(
        s.events(r.id).filter((e) => e.type === "coordination.committed")
          .length,
        1,
      );
    } finally {
      s.close();
    }
  });
}

test("role requests cannot change domain, select an ambiguous target or introduce unauthorized dependencies", () => {
  const initial: Plan = {
    rationale: "report",
    steps: [{ ...plan.steps[3]!, dependsOn: [] }],
  };
  const asked: Artifact = {
    ...requestArtifact,
    result: {
      ...base,
      collaboration: {
        kind: "assistance",
        targetStepId: null,
        targetRole: "profile",
        question: "need profile",
        evidenceIds: [],
      },
    },
  };
  const expanded: Plan = {
    rationale: "expanded",
    steps: [
      plan.steps[0]!,
      { ...plan.steps[0]!, id: "second-profile" },
      { ...plan.steps[3]!, dependsOn: ["profile"] },
    ],
  };
  assert.throws(
    () => revisePlan(initial, expanded, asked, [asked], {}, 3),
    /Unauthorized/,
  );
  assert.equal(
    revisePlan(initial, expanded, asked, [asked], {}, 3, "profile")
      .targetStepId,
    "profile",
  );
  assert.throws(
    () => revisePlan(initial, plan, asked, [asked], {}, 3, "match"),
    /Unauthorized/,
  );
  const bad = structuredClone(expanded);
  bad.steps[0]!.dependsOn = ["report"];
  bad.steps[2]!.dependsOn = [];
  assert.throws(
    () => revisePlan(initial, bad, asked, [asked], {}, 3, "profile"),
    /information-flow/,
  );
});

test("runtime failure classification never retries permanent, resource or unknown faults", () => {
  assert.equal(
    classifyFailure(new ProviderError("auth", false, 401)).retryable,
    false,
  );
  assert.equal(
    classifyFailure(new RuntimeLimitError("run_limit", "limit")).retryable,
    false,
  );
  assert.equal(classifyFailure(new Error("unexpected bug")).retryable, false);
  const failed = {
    ...artifacts[1]!,
    result: { ...base, status: "failed" as const },
    failure: classifyFailure(new ProviderError("temporary", true, 503)),
  };
  assert.deepEqual(
    retryFailedStep(plan, failed, artifacts, {}, 3).invalidatedStepIds,
    ["match", "path", "report"],
  );
  assert.throws(
    () => retryFailedStep(plan, failed, artifacts, { match: 3 }, 3),
    /attempt limit/,
  );
});

test("runtime stops transient retries at the attempt cap and never retries permanent provider errors", async () => {
  for (const retryable of [true, false]) {
    const replay = new ReplayProvider([
      call("plan_submit", { rationale: "画像", steps: [plan.steps[0]!] }),
      answer,
    ]);
    let attempts = 0;
    const provider: import("../src/contracts.js").ModelProvider = {
      mode: "replay",
      model: replay.model,
      async complete(messages, tools, signal, delta) {
        if (tools.some((t) => t.function.name === "resume_read")) {
          attempts++;
          throw new ProviderError(
            retryable ? "503 unavailable" : "401 unauthorized",
            retryable,
            retryable ? 503 : 401,
          );
        }
        return replay.complete(messages, tools, signal, delta);
      },
    };
    const s = new Store(":memory:");
    try {
      const rt = new Runtime(s, new Knowledge(dataset), provider, {
          ...config(),
          maxStepAttempts: 2,
        }),
        r = rt.create(request);
      const result = await rt.execute(r.id, request.userId);
      assert.equal(result.status, "failed");
      assert.equal(attempts, retryable ? 4 : 1);
      assert.equal(s.artifact(r.id, "profile")!.attempt, retryable ? 2 : 1);
      assert.ok(result.answer);
      assert.equal(
        s.events(r.id).filter((e) => e.type === "expert.started").length,
        retryable ? 2 : 1,
      );
    } finally {
      s.close();
    }
  }
});

for (const architecture of ["multi-agent", "skills"] as const) {
  test(`${architecture}: synthesis receives resource failure provenance without a false coordination-limit diagnosis`, async () => {
    const replay = new ReplayProvider([
      call("plan_submit", { rationale: "画像", steps: [plan.steps[0]!] }),
      answer,
    ]);
    let synthesized = false;
    const provider: import("../src/contracts.js").ModelProvider = {
      mode: "replay",
      model: replay.model,
      async complete(messages, tools, signal, delta) {
        if (tools.some((t) => t.function.name === "resume_read"))
          throw new RuntimeLimitError(
            "run_limit",
            "Run model/token limit exceeded",
          );
        if (!tools.length) {
          const content = messages.at(-1)!.content!;
          const payload = JSON.parse(content.slice(content.indexOf("{")));
          assert.equal(payload.results[0].failure.code, "run_limit");
          assert.equal(payload.results[0].stepId, "profile");
          assert.equal(payload.results[0].failure.retryable, false);
          assert(
            payload.facts.coordination.roundsUsed <
              payload.facts.coordination.roundLimit,
          );
          const reasons = JSON.stringify(
            payload.facts.coordination.resolutions,
          );
          assert.match(reasons, /该类型失败不可自动重试/);
          assert.doesNotMatch(reasons, /已达到协调/);
          synthesized = true;
        }
        return replay.complete(messages, tools, signal, delta);
      },
    };
    const s = new Store(":memory:");
    try {
      const rt = new Runtime(s, new Knowledge(dataset), provider, config());
      const r = rt.create({ ...request, architecture });
      assert.equal((await rt.execute(r.id, request.userId)).status, "failed");
      assert(synthesized);
      assert.equal(s.artifacts(r.id).length, 1);
    } finally {
      s.close();
    }
  });
}

test("turn-limit retry supersedes proposals from the failed attempt before any approval", async () => {
  const f = [
    call("plan_submit", { rationale: "画像", steps: [plan.steps[0]!] }),
    readRule("profile"),
    proposal("profile", "旧尝试提议"),
    readRule("profile"),
    call("expert_finish", {
      ...base,
      summary: "新尝试仍需输入",
      evidenceIds: ["rule:profile"],
    }),
    answer,
  ];
  const s = new Store(":memory:");
  try {
    const rt = new Runtime(s, new Knowledge(dataset), new ReplayProvider(f), {
        ...config(),
        maxTurns: 2,
      }),
      r = rt.create(request);
    assert.equal((await rt.execute(r.id, request.userId)).status, "partial");
    assert.equal(s.artifact(r.id, "profile")!.attempt, 2);
    assert.equal(s.proposals(r.id)[0]!.status, "superseded");
    assert.equal(s.approval(r.id), undefined);
    assert.equal(s.memories(request.userId, "profile").length, 0);
  } finally {
    s.close();
  }
});

test("replanning preserves unaffected artifacts, invalidates old/new consumers and bounds cycles/attempts", () => {
  const transition = revisePlan(
    plan,
    repaired,
    requestArtifact,
    artifacts,
    {},
    3,
  );
  assert.deepEqual(transition.invalidatedStepIds, ["match", "path", "report"]);
  assert.deepEqual(transition.attempts, { report: 2, match: 2, path: 2 });
  assert.throws(
    () =>
      revisePlan(plan, repaired, requestArtifact, artifacts, { match: 3 }, 3),
    /attempt limit/,
  );
  const cycle = structuredClone(repaired);
  cycle.steps[1]!.dependsOn.push("report");
  assert.throws(
    () => revisePlan(plan, cycle, requestArtifact, artifacts, {}, 3),
    /Cyclic/,
  );
  const deleted = {
    ...repaired,
    steps: repaired.steps.slice(1).map((s) => ({
      ...s,
      dependsOn: s.dependsOn.filter((id) => id !== "profile"),
    })),
  };
  assert.throws(
    () => revisePlan(plan, deleted, requestArtifact, artifacts, {}, 3),
    /remove steps/,
  );
  const noEdge = structuredClone(repaired);
  noEdge.steps[3]!.dependsOn = ["path"];
  assert.throws(
    () => revisePlan(plan, noEdge, requestArtifact, artifacts, {}, 3),
    /directly/,
  );
  const removedOldConsumer = structuredClone(repaired);
  removedOldConsumer.steps[2]!.dependsOn = ["profile"];
  assert.ok(
    revisePlan(
      plan,
      removedOldConsumer,
      requestArtifact,
      artifacts,
      {},
      3,
    ).invalidatedStepIds.includes("path"),
  );
});

test("collaboration requests enforce evidence and role boundaries and yield exactly one result", async () => {
  const s = new Store(":memory:");
  try {
    const k = new Knowledge(dataset),
      rt = new Runtime(s, k, new ReplayProvider([]), config()),
      run = rt.create(request);
    const t = new DomainTools(
      "profile",
      run,
      "profile",
      s,
      k,
      [],
      new AbortController().signal,
      { stepId: "profile", attempt: 1, directory: plan.steps },
    );
    await assert.rejects(
      t.invoke(
        "collaboration_request",
        {
          kind: "evidence",
          targetStepId: "match",
          question: "跨域读取",
          evidenceIds: [],
        },
        "deny",
      ),
      /Unauthorized/,
    );
    await assert.rejects(
      t.invoke(
        "collaboration_request",
        {
          kind: "conflict",
          targetStepId: "match",
          question: "未读引用",
          evidenceIds: ["invented"],
        },
        "deny2",
      ),
      /Unread/,
    );
    await t.invoke(
      "collaboration_request",
      {
        kind: "user_input",
        targetStepId: null,
        question: "请补充项目经历",
        evidenceIds: [],
      },
      "yield",
    );
    assert.equal(t.result?.status, "needs_input");
    assert.equal(t.result?.collaboration?.kind, "user_input");
    await assert.rejects(
      t.invoke("memory_recall", {}, "after-yield"),
      /already finalized/,
    );
  } finally {
    s.close();
  }
});

for (const architecture of ["multi-agent", "skills"] as const) {
  test(`${architecture}: repair survives commit/checkpoint crash and approval restart without duplicate work`, async () => {
    const f = [
      call("plan_submit", plan),
      readRule("profile"),
      call("profile_score", { observations: [] }),
      proposal("profile", "保留画像"),
      finish("profile", "画像不需要重跑"),
      readRule("match"),
      proposal("match", "旧匹配"),
      finish("match", "旧匹配"),
      readRule("path"),
      finish("path", "旧路径"),
      readRule("report"),
      call("collaboration_request", {
        ...requestArtifact.result.collaboration,
        evidenceIds: ["rule:report"],
      }),
      call("coordination_decide", {
        action: "revise",
        reason: "补证后重建下游",
        plan: repaired,
      }),
      readRule("match"),
      proposal("match", "新匹配"),
      finish("match", "新匹配"),
      readRule("path"),
      finish("path", "新路径"),
      readRule("report"),
      finish("report", "新报告"),
      answer,
    ];
    mkdirSync(resolve(ROOT, "var/tests"), { recursive: true });
    const path = resolve(
      mkdtempSync(resolve(ROOT, "var/tests/coordination-")),
      "runs.sqlite",
    );
    let s = new Store(path);
    const provider = new ReplayProvider(f),
      cfg = { ...config(), maxCalls: 40, concurrency: 1 };
    let rt = new Runtime(s, new Knowledge(dataset), provider, cfg);
    const run = rt.create({ ...request, architecture });
    try {
      const commit = s.applyCoordination.bind(s);
      s.applyCoordination = (...args) => {
        commit(...args);
        throw new Error(
          "Injected crash after revision commit, before root checkpoint",
        );
      };
      const interrupted = await rt.execute(run.id, request.userId);
      assert.equal(interrupted.status, "failed");
      assert.match(interrupted.error!, /Injected crash/);
      s.close();
      s = new Store(path);
      rt = new Runtime(s, new Knowledge(dataset), provider, cfg);
      const paused = await rt.execute(run.id, request.userId);
      assert.equal(paused.status, "waiting_approval", paused.error);
      const active = s.artifacts(run.id);
      assert.equal(active.length, 4);
      assert.equal(active.find((a) => a.stepId === "profile")!.attempt, 1);
      assert.equal(active.find((a) => a.stepId === "match")!.attempt, 2);
      assert.equal(
        active.find((a) => a.stepId === "report")!.result.summary,
        "新报告",
      );
      assert.deepEqual(
        s
          .artifactHistory(run.id)
          .filter((a) => a.invalidatedBy)
          .map((a) => a.artifact.stepId),
        ["match", "path", "report"],
      );
      assert.equal(
        s
          .events(run.id)
          .filter((e) => e.type === "expert.started" && e.expert === "profile")
          .length,
        1,
      );
      assert.equal(
        s.proposals(run.id).find((p) => p.proposal.value === "旧匹配")!.status,
        "superseded",
      );
      const newMatch = s
        .modelCalls(run.id)
        .filter((c) => c.role === "match")[3]!;
      assert.ok(JSON.stringify(newMatch.messages).includes("请补充限制来源"));
      assert.equal(
        JSON.stringify(newMatch.messages).includes("coordination_decide"),
        architecture === "skills",
      );
      const approval = s.cache(run.id, "approval-event") as {
        approvalId: string;
      };
      s.close();
      s = new Store(path);
      rt = new Runtime(s, new Knowledge(dataset), provider, cfg);
      assert.equal(
        (
          await rt.execute(run.id, request.userId, {
            decision: "approve",
            approvalId: approval.approvalId,
          })
        ).status,
        "partial",
      );
      assert.deepEqual(
        s.memories(request.userId, "match").map((m) => m.value),
        ["新匹配"],
      );
      assert.equal(s.memories(request.userId, "profile")[0]!.value, "保留画像");
      assert.equal(s.modelCalls(run.id).length, f.length);
      assert.equal(
        s.events(run.id).filter((e) => e.type === "coordination.committed")
          .length,
        1,
      );
    } finally {
      s.close();
    }
  });
}

test("coordination commit is atomic, replayable and keeps immutable history", () => {
  const s = new Store(":memory:");
  try {
    s.createRun({
      id: "r",
      request,
      status: "created",
      mode: "replay",
      datasetVersion: dataset.version,
      configHash: "fixture",
      constraintVersion: 1,
      createdAt: "",
      updatedAt: "",
    });
    for (const a of artifacts) s.saveArtifact(a);
    assert.throws(() =>
      s.applyCoordination("r", "bad", { unencodable: 1n }, ["match"]),
    );
    assert.ok(
      s.artifact("r", "match"),
      "failed transaction restores active artifact",
    );
    assert.equal(
      s.artifactHistory("r").find((h) => h.artifact.stepId === "match")!
        .invalidatedBy,
      null,
    );
    s.propose(
      "r",
      MemoryProposal.parse({
        namespace: "match",
        key: "test",
        value: "stale",
        evidenceIds: ["source"],
      }),
      { stepId: "match", attempt: 1 },
    );
    const update = { revision: 1 };
    s.applyCoordination("r", "coord-1", update, ["match", "path", "report"]);
    const replacement = { ...artifacts[1]!, id: "r:match@2", attempt: 2 };
    s.saveArtifact(replacement);
    assert.deepEqual(
      s.applyCoordination("r", "coord-1", { revision: 99 }, [
        "profile",
        "match",
      ]),
      update,
    );
    assert.equal(s.artifact("r", "match")!.id, replacement.id);
    assert.ok(s.artifact("r", "profile"));
    assert.equal(s.artifactHistory("r").length, 5);
    assert.equal(s.proposals("r")[0]!.status, "superseded");
    assert.throws(() => s.saveArtifact(artifacts[1]!), /replacement requires/);
    s.applyCoordination("r", "coord-2", {}, ["match"]);
    assert.throws(
      () => s.saveArtifact(artifacts[1]!),
      /identity cannot be reused/,
    );
  } finally {
    s.close();
  }
});

test("repeated repair requests stop at the coordination limit with unresolved requests retained", async () => {
  const shortPlan: Plan = {
    rationale: "匹配与报告",
    steps: [
      { ...plan.steps[1]!, dependsOn: [] },
      { ...plan.steps[3]!, dependsOn: ["match"] },
    ],
  };
  const repair = structuredClone(shortPlan);
  repair.steps[0]!.objective = "补充限制来源";
  const ask = call("collaboration_request", {
    kind: "evidence",
    targetStepId: "match",
    question: "仍需补证",
    evidenceIds: [],
  });
  const f = [
    call("plan_submit", shortPlan),
    readRule("match"),
    finish("match", "旧匹配"),
    ask,
    call("coordination_decide", {
      action: "revise",
      reason: "补证",
      plan: repair,
    }),
    readRule("match"),
    finish("match", "证据仍不足"),
    ask,
    answer,
  ];
  const s = new Store(":memory:");
  try {
    const rt = new Runtime(s, new Knowledge(dataset), new ReplayProvider(f), {
      ...config(),
      maxCoordinationRounds: 1,
    });
    const run = rt.create(request);
    const result = await rt.execute(run.id, request.userId);
    assert.equal(result.status, "partial", result.error);
    assert.equal(s.modelCalls(run.id).length, f.length);
    assert.equal(s.artifact(run.id, "report")!.attempt, 2);
    assert.equal(s.artifact(run.id, "report")!.result.status, "needs_input");
    assert.ok(
      JSON.stringify(s.modelCalls(run.id).at(-1)!.messages).includes(
        "协作轮数上限",
      ),
    );
  } finally {
    s.close();
  }
});

test("a skill cannot use historical private reads as current authorized evidence", async () => {
  const s = new Store(":memory:");
  try {
    const f = [
      call("plan_submit", {
        rationale: "检查隔离",
        steps: [plan.steps[0], { ...plan.steps[1]!, dependsOn: [] }],
      }),
      call("resume_read", {}),
      call("expert_finish", { ...base, summary: "不发布简历原文" }),
      call("expert_finish", { ...base, evidenceIds: ["resume:1"] }),
      call("expert_finish", base),
      answer,
    ];
    const rt = new Runtime(
      s,
      new Knowledge(dataset),
      new ReplayProvider(f),
      config(),
    );
    const run = rt.create({
      ...request,
      resumeText: "私有经历",
      architecture: "skills",
    });
    assert.equal((await rt.execute(run.id, request.userId)).status, "partial");
    const denied = s.events(run.id).filter((e) => e.type === "tool.failed");
    assert.equal(denied.length, 1);
    assert.match(JSON.stringify(denied), /Unread or unauthorized evidence/);
  } finally {
    s.close();
  }
});

test("user-input requests finish explicitly without calling a coordinator or inventing missing facts", async () => {
  const s = new Store(":memory:");
  try {
    const provider = new ReplayProvider([
      call("plan_submit", {
        rationale: "画像缺少简历",
        steps: [plan.steps[0]],
      }),
      call("collaboration_request", {
        kind: "user_input",
        targetStepId: null,
        question: "请提供简历",
        evidenceIds: [],
      }),
      answer,
    ]);
    const rt = new Runtime(s, new Knowledge(dataset), provider, config()),
      run = rt.create(request);
    assert.equal((await rt.execute(run.id, request.userId)).status, "partial");
    assert.equal(s.modelCalls(run.id).length, 3);
    assert.equal(
      s.artifacts(run.id)[0]!.result.collaboration!.question,
      "请提供简历",
    );
    assert.ok(
      JSON.stringify(s.modelCalls(run.id).at(-1)!.messages).includes(
        "需要用户补充信息",
      ),
    );
  } finally {
    s.close();
  }
});
