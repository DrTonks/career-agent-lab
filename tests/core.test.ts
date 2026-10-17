import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { resolve } from "node:path";
import {
  Dimensions,
  Request,
  validatePlan,
  type ModelReply,
  type RunRecord,
  type Artifact,
} from "../src/contracts.js";
import { ROOT } from "../src/config.js";
import { config } from "./test-config.js";
import { Store } from "../src/storage.js";
import { Runtime, compactMessages } from "../src/runtime.js";
import { ReplayProvider } from "../src/providers.js";
import { SqliteSaver } from "../src/checkpointer.js";
import { emptyCheckpoint } from "@langchain/langgraph-checkpoint";
import {
  loadDataset,
  salary,
  weekend,
  educationRank,
  experience,
  validateDataset,
} from "../src/data.js";
import { Knowledge, jobConstraintCheck, BM25 } from "../src/retrieval.js";
import { DomainTools } from "../src/tools.js";
const dataset = loadDataset(resolve(ROOT, "data/synthetic/dataset.json"));
const request = Request.parse({
  userId: "test-user",
  conversationId: "test-conversation",
  request: "分析简历",
  resumeText: "使用 Vue 完成了网页项目。",
  constraints: {},
  architecture: "multi-agent",
});
const reply = (name: string, args: unknown): { reply: ModelReply } => ({
  reply: {
    message: {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call-" + name,
          type: "function",
          function: { name, arguments: JSON.stringify(args) },
        },
      ],
    },
    usage: { input: 10, output: 10, cachedInput: 0 },
    finishReason: "tool_calls",
  },
});
const scores = Object.fromEntries(
  Dimensions.map((d) => [d, d === "professionalSkill" ? 50 : null]),
);
const result = {
  status: "partial",
  summary: "有网页项目证据，其他维度待补充。",
  evidenceIds: ["resume:1", "rule:profile"],
  unknowns: ["其他维度缺乏行为证据"],
  conflicts: [],
  nextActions: ["补充项目产出"],
  artifact: {
    scores,
    skills: ["Vue"],
    evidence: [
      {
        dimension: "professionalSkill",
        evidenceId: "resume:1",
        quote: "使用 Vue 完成了网页项目。",
      },
    ],
  },
};
function fixtures() {
  return [
    reply("plan_submit", {
      rationale: "仅需画像",
      steps: [
        {
          id: "profile",
          expert: "profile",
          objective: "分析简历",
          dependsOn: [],
        },
      ],
    }),
    reply("knowledge_read", { id: "rule:profile" }),
    reply("resume_read", {}),
    reply("profile_score", {
      observations: [
        {
          dimension: "professionalSkill",
          level: 2,
          confidence: 0.8,
          evidenceId: "resume:1",
          quote: "使用 Vue 完成了网页项目。",
          rationale: "有具体项目经历",
        },
      ],
    }),
    reply("expert_finish", result),
    {
      reply: {
        message: {
          role: "assistant",
          content: "画像部分完成，其他维度需要补充证据。",
        },
        usage: { input: 10, output: 10, cachedInput: 0 },
        finishReason: "stop",
      } as ModelReply,
    },
  ];
}
test("plan rejects cycles, missing dependencies and duplicate IDs", () => {
  assert.throws(
    () =>
      validatePlan({
        rationale: "",
        steps: [
          { id: "a", expert: "profile", objective: "x", dependsOn: ["b"] },
          { id: "b", expert: "match", objective: "x", dependsOn: ["a"] },
        ],
      }),
    /Cyclic/,
  );
  assert.throws(
    () =>
      validatePlan({
        rationale: "",
        steps: [
          {
            id: "a",
            expert: "profile",
            objective: "x",
            dependsOn: ["missing"],
          },
        ],
      }),
    /Missing/,
  );
  assert.throws(
    () =>
      validatePlan({
        rationale: "",
        steps: [
          { id: "a", expert: "profile", objective: "x", dependsOn: [] },
          { id: "a", expert: "profile", objective: "x", dependsOn: [] },
        ],
      }),
    /Duplicate/,
  );
});
test("salary and qualification parsers preserve uncertainty", () => {
  assert.deepEqual(salary("6-9K"), [6000, 9000]);
  assert.deepEqual(salary("1.2-1.8万/月"), [12000, 18000]);
  assert.deepEqual(salary("120-150元/天"), [null, null]);
  assert.equal(weekend("双休，但是大小周"), null);
  assert.equal(weekend("周末双休"), true);
  assert.equal(educationRank(""), null);
  assert.equal(experience("应届毕业生"), 0);
});
test("hard constraints do not silently accept unknowns", () => {
  const job = dataset.jobs[2]!;
  const c = Request.parse({
    ...request,
    constraints: { cities: ["北京"], weekendsOff: true },
  }).constraints;
  assert.equal(jobConstraintCheck(job, c).eligible, false);
  assert.deepEqual(jobConstraintCheck(job, c).unknowns, ["weekendsOff"]);
});
test("dataset rejects dangling graph edges", () => {
  assert.throws(
    () =>
      validateDataset({
        ...dataset,
        edges: [{ ...dataset.edges[0], target: "missing" }],
      }),
    /Dangling/,
  );
});
test("BM25 Chinese segmentation and ACL before retrieval", async () => {
  const index = new BM25(["岗位匹配与职业发展", "前端开发 Vue"]);
  assert.equal(index.rank("前端开发", [0, 1], 2)[0]?.i, 1);
  const k = new Knowledge(dataset);
  assert.throws(
    () => k.get("profile", "category:frontend-junior"),
    /accessible/,
  );
  assert.equal(
    (
      await k.search(
        "report",
        "Vue",
        { kind: "job" },
        new AbortController().signal,
      )
    ).length,
    0,
  );
});
test("memory is namespaced, versioned, expiring and explicitly committed", () => {
  const s = new Store(":memory:");
  const r: RunRecord = {
    id: "r",
    request,
    status: "created",
    mode: "replay",
    datasetVersion: "v",
    configHash: "c",
    constraintVersion: 1,
    createdAt: "",
    updatedAt: "",
  };
  s.createRun(r);
  s.propose("r", {
    namespace: "profile",
    key: "skill",
    value: "Vue",
    evidenceIds: ["resume:1"],
    expectedVersion: 0,
  });
  assert.equal(s.memories("test-user", "profile").length, 0);
  s.commitMemories("r");
  assert.equal(s.memories("test-user", "profile").length, 1);
  assert.equal(s.memories("test-user", "match").length, 0);
  assert.equal(s.memories("other", "profile").length, 0);
  s.propose("r", {
    namespace: "profile",
    key: "skill",
    value: "Java",
    evidenceIds: ["resume:1"],
    expectedVersion: 0,
  });
  assert.throws(() => s.commitMemories("r"), /conflict/);
  s.rejectMemories("r");
  s.propose("r", {
    namespace: "shared",
    key: "expired",
    value: "old preference",
    evidenceIds: ["resume:1"],
    expectedVersion: 0,
    expiresAt: "2000-01-01T00:00:00.000Z",
  });
  assert.throws(() => s.commitMemories("r"), /expired/);
  assert.ok(
    !s.memories("test-user", "profile").some((m) => m.key === "expired"),
  );
  s.close();
});
test("changing constraints invalidates old in-flight result", () => {
  const s = new Store(":memory:");
  const r: RunRecord = {
    id: "r",
    request,
    status: "running",
    mode: "replay",
    datasetVersion: "v",
    configHash: "c",
    constraintVersion: s.advanceConstraints(
      request.userId,
      request.conversationId,
      request.constraints,
    ),
    createdAt: "",
    updatedAt: "",
  };
  s.createRun(r);
  s.advanceConstraints(request.userId, request.conversationId, {
    cities: ["成都"],
  });
  assert.throws(() => s.assertCurrent(r), /changed/);
  assert.equal(s.run("r").status, "stale");
  s.close();
});
test("tool registry blocks cross-role execution and invented evidence", async () => {
  const s = new Store(":memory:"),
    runtime = new Runtime(
      s,
      new Knowledge(dataset),
      new ReplayProvider([]),
      config(),
    ),
    r = runtime.create(request),
    t = new DomainTools(
      "profile",
      r,
      "p",
      s,
      new Knowledge(dataset),
      [],
      new AbortController().signal,
    );
  await assert.rejects(
    t.invoke("jobs_search", { query: "Vue" }, "1"),
    /not allowed/,
  );
  await assert.rejects(
    t.invoke(
      "memory_propose",
      { namespace: "match", key: "x", value: "x", evidenceIds: ["invented"] },
      "2",
    ),
    /namespace/,
  );
  await assert.rejects(t.invoke("expert_finish", result, "3"), /Unread/);
  s.close();
});
test("SQLite saver survives connection restart and orders pending writes", async () => {
  mkdirSync(resolve(ROOT, "tmp/tests"), { recursive: true });
  const file = resolve(
    mkdtempSync(resolve(ROOT, "tmp/tests/checkpoint-")),
    "state.sqlite",
  );
  let s = new Store(file),
    cp = new SqliteSaver(s);
  const c = emptyCheckpoint();
  const cfg = await cp.put({ configurable: { thread_id: "r" } }, c, {
    source: "input",
    step: 0,
    parents: {},
  });
  await cp.putWrites(cfg, [["value", 1]], "b", "z");
  await cp.putWrites(cfg, [["value", 2]], "a", "a");
  s.close();
  s = new Store(file);
  cp = new SqliteSaver(s);
  const got = await cp.getTuple({ configurable: { thread_id: "r" } });
  assert.equal(got?.checkpoint.id, c.id);
  assert.deepEqual(
    got?.pendingWrites?.map((w) => w[2]),
    [2, 1],
  );
  s.close();
});
test("real LangGraph execution with explicit replay produces persisted partial profile", async () => {
  const s = new Store(":memory:");
  const r = new Runtime(
    s,
    new Knowledge(dataset),
    new ReplayProvider(fixtures()),
    config(),
  );
  const run = r.create(request);
  const done = await r.execute(run.id, request.userId);
  assert.equal(done.status, "partial", done.error);
  assert.equal(s.artifacts(run.id).length, 1);
  assert.equal(
    s.artifacts(run.id)[0]!.result.artifact.scores &&
      Object.keys(s.artifacts(run.id)[0]!.result.artifact.scores as object)
        .length,
    12,
  );
  assert.equal(s.modelCalls(run.id).length, 6);
  assert.equal(
    s.events(run.id).filter((e) => e.type === "tool.completed").length,
    4,
  );
  s.close();
});
test("approval survives process-like restart and rejects stale approval IDs", async () => {
  mkdirSync(resolve(ROOT, "tmp/tests"), { recursive: true });
  const file = resolve(
    mkdtempSync(resolve(ROOT, "tmp/tests/approval-")),
    "state.sqlite",
  );
  let s = new Store(file);
  let rt = new Runtime(
    s,
    new Knowledge(dataset),
    new ReplayProvider(fixtures().slice(0, -1)),
    config(),
  );
  const run = rt.create({ ...request, approvalRequired: true });
  const paused = await rt.execute(run.id, request.userId);
  assert.equal(paused.status, "waiting_approval", paused.error);
  const approval = s.events(run.id).find((e) => e.type === "approval.required")!
    .payload as { approvalId: string };
  s.close();
  s = new Store(file);
  rt = new Runtime(
    s,
    new Knowledge(dataset),
    new ReplayProvider(fixtures().slice(-1)),
    config(),
  );
  await assert.rejects(
    rt.execute(run.id, request.userId, {
      decision: "approve",
      approvalId: "stale-id",
    }),
    /Approval ID mismatch/,
  );
  assert.equal(s.run(run.id).status, "waiting_approval");
  const done = await rt.execute(run.id, request.userId, {
    decision: "approve",
    approvalId: approval.approvalId,
  });
  assert.equal(done.status, "partial", done.error);
  assert.equal(s.modelCalls(run.id).length, 6);
  assert.equal(s.artifacts(run.id).length, 1);
  s.close();
});
test("skills and isolated experts share domain tools and professional content", async () => {
  const s = new Store(":memory:");
  const rt = new Runtime(
    s,
    new Knowledge(dataset),
    new ReplayProvider(fixtures()),
    config(),
  );
  const run = rt.create({ ...request, architecture: "skills" });
  const done = await rt.execute(run.id, request.userId);
  assert.equal(done.status, "partial", done.error);
  const event = s.events(run.id).find((e) => e.type === "expert.started")!;
  assert.equal((event.payload as any).independentContext, false);
  s.close();
});
test("context compaction preserves tool call/result pairs", () => {
  const messages: any[] = [
    { role: "system", content: "rules" },
    { role: "user", content: "task" },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "a", type: "function", function: { name: "x", arguments: "{}" } },
      ],
    },
    { role: "tool", tool_call_id: "a", content: "x".repeat(2000) },
    { role: "user", content: "continue" },
  ];
  const result = compactMessages(messages, 300);
  assert.equal(result.removed, 2);
  assert.equal(
    result.messages.some((m) => m.role === "tool"),
    false,
  );
});
test("handoff pages do not recursively broadcast sources or grant unread citations", async () => {
  const s = new Store(":memory:");
  const k = new Knowledge(dataset);
  const rt = new Runtime(s, k, new ReplayProvider([]), config());
  const run = rt.create(request);
  const a: Artifact = {
    id: "upstream",
    runId: run.id,
    stepId: "profile",
    expert: "profile",
    version: 1,
    result: {
      ...result,
      artifact: { ...result.artifact, extended: "long".repeat(10000) },
    } as any,
    publishedEvidence: [
      {
        id: "resume:1",
        sourceId: "input:resume:1",
        kind: "resume",
        version: "v1",
        text: "private source".repeat(10000),
      },
    ],
  };
  const t = new DomainTools(
    "report",
    run,
    "report",
    s,
    k,
    [a],
    new AbortController().signal,
  );
  assert.throws(() => t.assertEvidence(["resume:1"]), /Unread/);
  const first = (await t.invoke(
    "artifact_read",
    { id: a.id, maxChars: 1000 },
    "a",
  )) as any;
  assert.equal(first.evidence.text.length, 1000);
  assert.equal(first.nextOffset, 1000);
  assert.ok(JSON.stringify(first).length < 2000);
  assert.throws(() => t.assertEvidence(["resume:1"]), /Unread/);
  const source = (await t.invoke(
    "knowledge_read",
    { id: "resume:1", maxChars: 500 },
    "b",
  )) as any;
  assert.equal(source.evidence.text.length, 500);
  t.assertEvidence(["resume:1"]);
  await assert.rejects(
    t.invoke("knowledge_read", { id: "resume:unpublished" }, "c"),
    /accessible/,
  );
  s.close();
});
test("compaction retains current skill activation after earlier history is dropped", () => {
  const messages: any[] = [
    { role: "system", content: "skills" },
    { role: "user", content: "TASK_DATA first skill" },
    { role: "assistant", content: "old ".repeat(2000) },
    { role: "user", content: "TASK_DATA active report skill" },
    { role: "assistant", content: "old ".repeat(2000) },
    { role: "user", content: "Please repair" },
  ];
  const compacted = compactMessages(messages, 200);
  assert.ok(
    compacted.messages.some(
      (m) => m.content === "TASK_DATA active report skill",
    ),
  );
  assert.equal(compacted.removed, 2);
});
test("erasing user data also removes expert checkpoints and private traces", async () => {
  const s = new Store(":memory:");
  const rt = new Runtime(
    s,
    new Knowledge(dataset),
    new ReplayProvider(fixtures()),
    config(),
  );
  const run = rt.create(request);
  assert.equal((await rt.execute(run.id, request.userId)).status, "partial");
  s.forgetUser(request.userId);
  assert.equal(s.listRuns(request.userId).length, 0);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM checkpoints").get()!.n, 0);
  assert.equal(s.events(run.id).length, 0);
  s.close();
});

test("actual multi-step request manifests isolate expert drafts while skills retain their history", async () => {
  for (const architecture of ["multi-agent", "skills"] as const) {
    const f = fixtures();
    const plan = reply("plan_submit", {
      rationale: "two domains",
      steps: [
        {
          id: "profile",
          expert: "profile",
          objective: "profile",
          dependsOn: [],
        },
        {
          id: "match",
          expert: "match",
          objective: "match",
          dependsOn: ["profile"],
        },
      ],
    });
    const profileCalls = f.slice(1, -1);
    profileCalls[0]!.reply.message.content = "PRIVATE_PROFILE_DRAFT_CANARY";
    const responses = [
      plan,
      ...profileCalls,
      reply("knowledge_read", { id: "rule:match" }),
      reply("expert_finish", {
        status: "needs_input",
        summary: "需确认岗位范围",
        evidenceIds: ["rule:match"],
        unknowns: ["范围待确认"],
        conflicts: [],
        nextActions: ["补充范围"],
        artifact: {},
      }),
      f.at(-1)!,
    ];
    const s = new Store(":memory:");
    const rt = new Runtime(
      s,
      new Knowledge(dataset),
      new ReplayProvider(responses),
      config(),
    );
    const run = rt.create({ ...request, architecture });
    assert.equal((await rt.execute(run.id, request.userId)).status, "partial");
    const matchManifest = s.modelCalls(run.id).find((c) => c.role === "match")!;
    assert.equal(
      JSON.stringify(matchManifest.messages).includes(
        "PRIVATE_PROFILE_DRAFT_CANARY",
      ),
      architecture === "skills",
    );
    assert.equal(s.artifacts(run.id).length, 2);
    s.close();
  }
});

test("saved report drafts support exact edits and finalize without regenerating the full report", async () => {
  const s = new Store(":memory:"),
    k = new Knowledge(dataset);
  const rt = new Runtime(s, k, new ReplayProvider([]), config()),
    run = rt.create(request);
  const t = new DomainTools(
    "report",
    run,
    "report",
    s,
    k,
    [],
    new AbortController().signal,
  );
  await t.invoke("knowledge_read", { id: "rule:report" }, "read");
  const draft = (await t.invoke(
    "report_check",
    {
      markdown: "个人画像\n岗位匹配\n发展路径\n行动计划\n限制与待确认\n旧文字",
      claims: [{ text: "内容待核实", evidenceIds: ["rule:report"] }],
      protectedText: [],
    },
    "save",
  )) as any;
  assert.equal(draft.valid, true);
  await assert.rejects(
    t.invoke(
      "report_edit",
      { draftId: draft.draftId, find: "missing", replace: "new" },
      "bad",
    ),
    /exactly one match/,
  );
  const edited = (await t.invoke(
    "report_edit",
    { draftId: draft.draftId, find: "旧文字", replace: "已修改" },
    "edit",
  )) as any;
  await t.invoke(
    "expert_finish",
    {
      status: "partial",
      summary: "结构完成，内容待核实",
      evidenceIds: ["rule:report"],
      unknowns: ["缺少上游"],
      conflicts: [],
      nextActions: [],
      artifact: { draftId: edited.draftId },
    },
    "finish",
  );
  assert.ok(String(t.result?.artifact.markdown).includes("已修改"));
  assert.ok(!String(t.result?.artifact.markdown).includes("旧文字"));
  const invalidTools = new DomainTools(
    "report",
    run,
    "report-invalid",
    s,
    k,
    [],
    new AbortController().signal,
  );
  await invalidTools.invoke(
    "knowledge_read",
    { id: "rule:report" },
    "read-invalid",
  );
  const invalid = (await invalidTools.invoke(
    "report_check",
    {
      markdown: "个人画像 岗位匹配 发展路径 行动计划 限制与待确认",
      claims: [{ text: "待核实", evidenceIds: ["rule:report"] }],
      protectedText: ["user exact wording"],
    },
    "invalid",
  )) as any;
  assert.equal(invalid.valid, false);
  await assert.rejects(
    invalidTools.invoke(
      "expert_finish",
      {
        status: "partial",
        summary: "draft",
        evidenceIds: ["rule:report"],
        unknowns: [],
        conflicts: [],
        nextActions: [],
        artifact: { draftId: invalid.draftId },
      },
      "invalid-finish",
    ),
    /Protected text/,
  );
  s.close();
});

test("cancellation during a model response cannot commit late expert artifacts", async () => {
  const s = new Store(":memory:");
  const responses = fixtures();
  let calls = 0,
    id = "";
  const provider = {
    mode: "replay" as const,
    model: "cancel-fixture",
    async complete() {
      if (calls === 1) s.cancel(id, request.userId);
      return responses[calls++]!.reply;
    },
  };
  const rt = new Runtime(s, new Knowledge(dataset), provider, config());
  const run = rt.create(request);
  id = run.id;
  assert.equal((await rt.execute(id, request.userId)).status, "cancelled");
  assert.equal(s.artifacts(id).length, 0);
  assert.ok(
    s.modelCalls(id).at(-1)!.response,
    "late rejected response remains in the audit record",
  );
  assert.deepEqual(s.modelCalls(id).at(-1)!.usage, responses[1]!.reply.usage);
  s.close();
});

test("resume identity includes graph and retrieval configuration, not only document text", () => {
  const base = new Knowledge(dataset);
  const editedGraph = new Knowledge({
    ...dataset,
    edges: dataset.edges.slice(1),
  });
  assert.equal(base.snapshotHash, editedGraph.snapshotHash);
  assert.notEqual(base.executionHash, editedGraph.executionHash);
  const vector = new Knowledge(dataset, {
    mode: "test",
    fingerprint: "model-version-1",
    async rank() {
      return [];
    },
  });
  assert.notEqual(base.executionHash, vector.executionHash);
});
