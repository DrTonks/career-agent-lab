import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { ROOT, hash } from "../src/config.js";
import { Store } from "../src/storage.js";
import { Runtime, EXECUTION_STATE_PREFIX } from "../src/runtime.js";
import { ReplayProvider } from "../src/providers.js";
import { Knowledge } from "../src/retrieval.js";
import { loadDataset } from "../src/data.js";
import { DomainTools } from "../src/tools.js";
import {
  Clarifications,
  ClarificationEvidenceError,
  ClarificationFeedbackError,
} from "../src/clarification.js";
import { continuationContext } from "../src/follow-up.js";
import type {
  Artifact,
  ExpertResult,
  ModelReply,
  Role,
} from "../src/contracts.js";
import { config } from "./test-config.js";

const knowledge = new Knowledge(
  loadDataset(resolve(ROOT, "data/synthetic/dataset.json")),
);
const result = (unknowns: string[] = []): ExpertResult => ({
  status: "needs_input",
  summary: "存在待核验项",
  evidenceIds: [],
  unknowns,
  conflicts: [],
  nextActions: [],
  artifact: {},
});
function setup(
  role: Role = "match",
  userQuestion = false,
  architecture: "multi-agent" | "skills" = "multi-agent",
  unknowns = ["岗位条件及当前核验状态？"],
) {
  const store = new Store(":memory:");
  const runtime = new Runtime(
    store,
    knowledge,
    new ReplayProvider([]),
    config(),
  );
  const parent = runtime.create({
    userId: "u",
    conversationId: "c",
    architecture,
    request: "仅研究公开合成岗位",
  });
  const r = result(unknowns);
  if (userQuestion)
    r.collaboration = {
      kind: "user_input",
      question: "本人是否同意放宽城市限制？",
      targetStepId: null,
      evidenceIds: [],
    };
  store.saveArtifact({
    id: `${parent.id}:${role}`,
    runId: parent.id,
    stepId: role,
    expert: role,
    version: 1,
    result: r,
  });
  store.update(parent.id, { status: "partial" });
  const run = runtime.reply(parent.id, "u", {
    operationId: "reply",
    reply: "我希望在北京工作，仍要求双休。",
    resumeText: "本科应届生",
  });
  const upstream: Artifact = {
    id: `${run.id}:profile`,
    runId: run.id,
    stepId: "profile",
    expert: "profile",
    version: 1,
    result: result(["部分能力尚未评估"]),
  };
  const tools = new DomainTools(
    role,
    run,
    role,
    store,
    knowledge,
    role === "profile" ? [] : [upstream],
    new AbortController().signal,
  );
  return {
    store,
    run,
    tools,
    upstream,
    q: continuationContext(run, role)!.questions,
  };
}
async function inputs(tools: DomainTools) {
  await tools.invoke("input_read", { source: "request" }, "request");
  await tools.invoke("input_read", { source: "resume" }, "resume");
}
const claim = (
  subject: "user" | "domain" | "state",
  evidenceId: string,
  quote: string,
) => ({ subject, text: quote, citations: [{ evidenceId, quote }] });
const update = (questionId: string, claims: ReturnType<typeof claim>[]) => ({
  questionId,
  expectedVersion: 0,
  status: "answered",
  claims,
  remaining: [],
  reason: "逐条按实际来源核验",
});

for (const role of ["profile", "match", "path", "report"] as const)
  test(`${role}: own domain rules can resolve domain unknowns without promoting them to personal facts`, async () => {
    const { store, run, tools, q } = setup(role);
    try {
      await inputs(tools);
      const read = (await tools.invoke(
        "knowledge_read",
        { id: `rule:${role}` },
        "rule",
      )) as any;
      const c = claim(
        "domain",
        read.evidence.id,
        read.evidence.text.slice(0, 40),
      );
      await tools.invoke(
        "clarification_update",
        { updates: [update(q[0]!.questionId, [c])] },
        "resolve",
      );
      await tools.invoke("expert_finish", result(), "finish");
      assert.deepEqual(tools.result!.evidenceIds, [c.citations[0]!.evidenceId]);
      assert.equal(
        new Clarifications(store, run, role, role).current()[0]!.schemaVersion,
        "clarification-v2",
      );
      assert.equal(store.memories("u", role).length, 0);
    } finally {
      store.close();
    }
  });

test("mixed user, job, calculation and artifact claims publish read sources; wrong kinds/unread/quotes give distinct atomic feedback", async () => {
  const { store, run, tools, upstream, q } = setup();
  try {
    await inputs(tools);
    const jobs = (await tools.invoke(
      "jobs_search",
      { query: "前端", categoryIds: ["frontend-junior"] },
      "search",
    )) as any;
    const job = (await tools.invoke(
      "knowledge_read",
      { id: "job:synthetic-1-3" },
      "job",
    )) as any;
    const state = (await tools.invoke(
      "artifact_read",
      { id: upstream.id },
      "artifact",
    )) as any;
    const rule = (await tools.invoke(
      "knowledge_read",
      { id: "rule:match" },
      "rule",
    )) as any;
    const personal = claim(
      "user",
      `input:${run.id}:request`,
      "我希望在北京工作，仍要求双休。",
    );
    const domain = claim(
      "domain",
      job.evidence.id,
      job.evidence.text.slice(0, 100),
    );
    const calculation = claim(
      "state",
      jobs.evidence.id,
      jobs.evidence.text.slice(0, 100),
    );
    const status = claim("state", state.evidence.id, "部分能力尚未评估");
    for (const [c, code, actualKind] of [
      [{ ...domain, subject: "user" }, "clarification_source_kind", "job"],
      [
        claim("state", rule.evidence.id, rule.evidence.text.slice(0, 40)),
        "clarification_source_kind",
        "rule",
      ],
      [
        claim("domain", "job:foreign", "不存在"),
        "clarification_source_unread",
        null,
      ],
      [
        claim("domain", job.evidence.id, "这个原文里没有的句子"),
        "clarification_quote_mismatch",
        "job",
      ],
    ] as const) {
      await assert.rejects(
        tools.invoke(
          "clarification_update",
          { updates: [update(q[0]!.questionId, [personal, c])] },
          "invalid",
        ),
        (e: any) => {
          assert(e instanceof ClarificationEvidenceError);
          assert.equal(e.feedback.code, code);
          assert.equal(e.feedback.actualKind, actualKind);
          assert.equal(e.feedback.claimIndex, 1);
          return true;
        },
      );
      assert.deepEqual(
        new Clarifications(store, run, "match", "match").current(),
        [],
      );
      const failure = store
        .events(run.id)
        .filter((e) => e.type === "tool.failed")
        .at(-1)!;
      assert.equal((failure.payload as any).feedback.code, code);
    }
    const claims = [personal, domain, calculation, status];
    await tools.invoke(
      "clarification_update",
      { updates: [update(q[0]!.questionId, claims)] },
      "mixed",
    );
    await tools.invoke("expert_finish", result(), "finish");
    assert.deepEqual(
      tools.result!.evidenceIds,
      claims.map((c) => c.citations[0]!.evidenceId),
    );
    const published = tools.result!.artifact.clarifications as any[];
    assert.deepEqual(published[0].claims, claims);
    assert(!("answer" in published[0]));
    // An upstream published ID is not a read receipt for the downstream expert.
    const artifact: Artifact = {
      ...upstream,
      id: `${run.id}:match`,
      stepId: "match",
      expert: "match",
      result: tools.result!,
      publishedEvidence: [...tools.seen.values()].filter((e) =>
        tools.result!.evidenceIds.includes(e.id),
      ),
    };
    const downstream = new DomainTools(
      "report",
      run,
      "report",
      store,
      knowledge,
      [artifact],
      new AbortController().signal,
    );
    assert(!downstream.seen.has(domain.citations[0]!.evidenceId));
    const reRead = (await downstream.invoke(
      "knowledge_read",
      { id: domain.citations[0]!.evidenceId },
      "published",
    )) as any;
    assert.equal(reRead.evidence.id, domain.citations[0]!.evidenceId);
  } finally {
    store.close();
  }
});

test("user-input questions require a user claim; conflict structure requires distinct claims and quotes, not a false conflict for a correction", async () => {
  const { store, run, tools, q } = setup("match", true);
  try {
    await inputs(tools);
    const read = (await tools.invoke(
      "knowledge_read",
      { id: "rule:match" },
      "rule",
    )) as any;
    const questionId = q.find((q) => q.kind === "user_input")!.questionId;
    await assert.rejects(
      tools.invoke(
        "clarification_update",
        {
          updates: [
            update(questionId, [
              claim(
                "domain",
                read.evidence.id,
                read.evidence.text.slice(0, 40),
              ),
            ]),
          ],
        },
        "no-consent",
      ),
      /requires_user_statement/,
    );
    const c = claim(
      "user",
      `input:${run.id}:request`,
      "我希望在北京工作，仍要求双休。",
    );
    const u = update(questionId, [c]);
    await assert.rejects(
      tools.invoke(
        "clarification_update",
        {
          updates: [
            { ...u, status: "conflict", claims: [c, c], remaining: ["待确认"] },
          ],
        },
        "fake-conflict",
      ),
      /two_cited_statements/,
    );
    await tools.invoke("clarification_update", { updates: [u] }, "resolved");
    assert.equal(
      new Clarifications(store, run, "match", "match").current()[0]!.status,
      "answered",
    );
  } finally {
    store.close();
  }
});

const call = (name: string, args: unknown): { reply: ModelReply } => ({
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
});

test("clarification state rejection locates the first invalid entry, preserves the whole batch, and exposes no other-role question", async () => {
  const { store, run, tools, q } = setup("match", false, "multi-agent", [
    "希望在哪个城市？",
    "全职/实习形式偏好",
  ]);
  try {
    await assert.rejects(
      tools.invoke(
        "clarification_update",
        { updates: [update(q[0]!.questionId, [])] },
        "unread",
      ),
      (e: unknown) => {
        assert(e instanceof ClarificationFeedbackError);
        assert.equal(e.feedback.code, "clarification_input_incomplete");
        assert.deepEqual(e.feedback.applied, []);
        assert.equal((e.feedback.coverage as any).resume.complete, false);
        return true;
      },
    );
    await inputs(tools);
    const c = claim(
      "user",
      `input:${run.id}:request`,
      "我希望在北京工作，仍要求双休。",
    );
    const first = update(q[0]!.questionId, [c]);
    const bad = {
      ...update(q[1]!.questionId, [c]),
      status: "partial",
      remaining: [q[1]!.text],
    };
    await assert.rejects(
      tools.invoke(
        "clarification_update",
        { updates: [first, bad] },
        "bad-batch",
      ),
      (e: unknown) => {
        assert(e instanceof ClarificationFeedbackError);
        assert.equal(e.feedback.updateIndex, 1);
        assert.equal(e.feedback.questionId, q[1]!.questionId);
        assert.equal(e.feedback.questionText, q[1]!.text);
        assert.equal(e.feedback.currentVersion, 0);
        assert.match(
          String(e.feedback.instruction),
          /unanswered with claims=\[\]/,
        );
        return true;
      },
    );
    const state = new Clarifications(store, run, "match", "match");
    assert.deepEqual(state.current(), []);
    const corrections = [first, { ...bad, status: "unanswered", claims: [] }];
    await tools.invoke(
      "clarification_update",
      { updates: corrections },
      "corrected",
    );
    assert.deepEqual(
      state.current().map((r) => r.version),
      [1, 1],
    );
    // Identical command is idempotent; a changed stale command is rejected.
    await tools.invoke(
      "clarification_update",
      { updates: corrections },
      "retry",
    );
    await assert.rejects(
      tools.invoke(
        "clarification_update",
        { updates: [{ ...first, reason: "新的解释" }] },
        "stale",
      ),
      (e: unknown) => {
        assert(e instanceof ClarificationFeedbackError);
        assert.equal(e.feedback.code, "clarification_version_conflict");
        assert.equal(e.feedback.currentVersion, 1);
        return true;
      },
    );
    await assert.rejects(
      tools.invoke(
        "clarification_update",
        {
          updates: [{ ...first, questionId: "another-role-private-question" }],
        },
        "foreign",
      ),
      (e: unknown) => {
        assert(e instanceof ClarificationFeedbackError);
        assert.equal(e.feedback.questionText, null);
        assert.equal(e.feedback.currentVersion, null);
        return true;
      },
    );
    assert.deepEqual(
      state.current().map((r) => r.version),
      [1, 1],
    );
  } finally {
    store.close();
  }
});

for (const architecture of ["multi-agent", "skills"] as const)
  test(`${architecture}: Runtime locates the failing entry in a 30-question batch and accepts a corrected unanswered state`, async () => {
    const unknowns = Array.from({ length: 30 }, (_, i) =>
      i === 29 ? "全职/实习形式偏好" : `待补充资料${i}`,
    );
    const { store, run, q } = setup("match", false, architecture, unknowns);
    try {
      const updates = q.map((x) => ({
        ...update(x.questionId, []),
        status: "unanswered",
        remaining: [x.text],
      }));
      const invalid = updates.map((u, i) =>
        i === 29
          ? {
              ...u,
              status: "partial",
              claims: [claim("user", `input:${run.id}:resume`, "本科应届生")],
            }
          : u,
      );
      const provider = new ReplayProvider([
        call("plan_submit", {
          rationale: "逐项解决追问",
          steps: [
            {
              id: "match",
              expert: "match",
              objective: "更新领域问题",
              dependsOn: [],
            },
          ],
        }),
        call("input_read", { source: "request" }),
        call("input_read", { source: "resume" }),
        call("clarification_update", { updates: invalid }),
        call("clarification_update", { updates }),
        call("expert_finish", result()),
        {
          reply: {
            message: {
              role: "assistant",
              content: "协议回放完成，仍需用户补充偏好",
            },
            usage: { input: 10, output: 10, cachedInput: 0 },
            finishReason: "stop",
          },
        },
      ]);
      await new Runtime(store, knowledge, provider, config()).execute(
        run.id,
        "u",
      );
      const artifact = store.artifact(run.id, "match")!;
      const expertCalls = store
        .modelCalls(run.id)
        .filter((c) => c.role === "match");
      for (const c of expertCalls) {
        assert.equal(c.executionStateHash, hash(c.executionState));
        const views = (c.messages as any[]).filter((m) =>
          m.content?.startsWith(EXECUTION_STATE_PREFIX),
        );
        assert.equal(views.length, 1);
        assert.equal(
          JSON.parse(views[0].content.slice(EXECUTION_STATE_PREFIX.length))
            .stateHash,
          c.executionStateHash,
        );
      }
      assert(
        (expertCalls[0]!.executionState as any).questions.every(
          (q: any) => q.version === 0,
        ),
      );
      assert(
        (expertCalls.at(-1)!.executionState as any).questions.every(
          (q: any) => q.version === 1,
        ),
      );
      assert(!artifact.failure);
      const records = artifact.result.artifact.clarifications as any[];
      assert.equal(records.length, 30);
      assert(
        records.every((r) => r.version === 1 && r.status === "unanswered"),
      );
      const feedback = (
        store.modelCalls(run.id)[4]!.messages as {
          role: string;
          content: string;
        }[]
      )
        .filter((m) => m.role === "tool")
        .map((m) => {
          try {
            return JSON.parse(m.content);
          } catch {
            return {};
          }
        })
        .find(
          (m) =>
            m.code === "clarification_partial_must_narrow_remaining_question",
        );
      assert.equal(feedback.updateIndex, 29);
      assert.equal(feedback.questionText, "全职/实习形式偏好");
      assert.equal(feedback.currentVersion, 0);
      assert.deepEqual(feedback.applied, []);
      const failed = store
        .events(run.id)
        .filter((e) => e.type === "tool.failed");
      assert.equal(failed.length, 1);
      assert.equal(
        (failed[0]!.payload as any).feedback.questionId,
        q[29]!.questionId,
      );
      assert.equal(
        store.events(run.id).filter((e) => e.type === "clarification.updated")
          .length,
        1,
      );
    } finally {
      store.close();
    }
  });
for (const architecture of ["multi-agent", "skills"] as const)
  test(`${architecture}: Runtime delivers structured wrong-kind feedback and accepts a corrected domain submission`, async () => {
    const { store, run, q } = setup("match", false, architecture);
    try {
      const source = knowledge.get("match", "rule:match");
      const c = claim("domain", source.id, source.text.slice(0, 40));
      const provider = new ReplayProvider([
        call("plan_submit", {
          rationale: "复核领域问题",
          steps: [
            {
              id: "match",
              expert: "match",
              objective: "核验岗位规则",
              dependsOn: [],
            },
          ],
        }),
        call("input_read", { source: "request" }),
        call("input_read", { source: "resume" }),
        call("knowledge_read", { id: source.id }),
        call("clarification_update", {
          updates: [update(q[0]!.questionId, [{ ...c, subject: "user" }])],
        }),
        call("clarification_update", {
          updates: [update(q[0]!.questionId, [c])],
        }),
        call("expert_finish", result()),
        {
          reply: {
            message: {
              role: "assistant",
              content: "协议回放完成，不是语义质量评估",
            },
            usage: { input: 10, output: 10, cachedInput: 0 },
            finishReason: "stop",
          },
        },
      ]);
      await new Runtime(store, knowledge, provider, config()).execute(
        run.id,
        "u",
      );
      const a = store.artifact(run.id, "match")!;
      assert(!a.failure);
      assert.equal(
        (a.result.artifact.clarifications as any[])[0].claims[0].subject,
        "domain",
      );
      const calls = store.modelCalls(run.id);
      const feedback = (calls[5]!.messages as any[])
        .filter((m) => m.role === "tool")
        .map((m) => {
          try {
            return JSON.parse(m.content);
          } catch {
            return {};
          }
        })
        .find((m) => m.code === "clarification_source_kind");
      assert.equal(feedback.actualKind, "rule");
      assert.equal(feedback.recoverable, true);
      assert.match(feedback.instruction, /Re-reading/);
      assert.equal(
        store.events(run.id).filter((e) => e.type === "tool.failed").length,
        1,
      );
    } finally {
      store.close();
    }
  });
