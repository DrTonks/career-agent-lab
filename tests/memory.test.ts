import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { resolve } from "node:path";
import { Store } from "../src/storage.js";
import { Runtime } from "../src/runtime.js";
import { ReplayProvider } from "../src/providers.js";
import { Knowledge } from "../src/retrieval.js";
import { ROOT } from "../src/config.js";
import { config } from "./test-config.js";
import { loadDataset } from "../src/data.js";
import { Request, type ModelReply } from "../src/contracts.js";
import { DomainTools } from "../src/tools.js";

const request = Request.parse({
  userId: "memory-owner",
  conversationId: "conversation",
  request: "记忆与审批测试",
});
const data = loadDataset(resolve(ROOT, "data/synthetic/dataset.json"));
const runtime = (s: Store, replies: { reply: ModelReply }[] = []) =>
  new Runtime(s, new Knowledge(data), new ReplayProvider(replies), config());
function seed(s: Store) {
  const run = runtime(s).create(request);
  s.propose(run.id, {
    namespace: "shared",
    key: "city",
    value: "西安",
    evidenceIds: ["user:city"],
    expectedVersion: 0,
  });
  s.commitMemories(run.id);
  s.update(run.id, { status: "succeeded" });
  return s.run(run.id);
}
const correction = {
  operation: "correct",
  operationId: "correct-city",
  namespace: "shared",
  key: "city",
  expectedVersion: 1,
  value: "成都",
  reason: "用户更正城市偏好",
};
const retraction = {
  operation: "retract",
  operationId: "retract-city",
  namespace: "shared",
  key: "city",
  expectedVersion: 2,
  reason: "用户不再确认此偏好",
};
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
const answer: { reply: ModelReply } = {
  reply: {
    message: { role: "assistant", content: "当前结果与待确认项已列出。" },
    usage: { input: 10, output: 10, cachedInput: 0 },
    finishReason: "stop",
  },
};
function approvalFixture() {
  return [
    call("plan_submit", {
      rationale: "需要画像确认",
      steps: [
        {
          id: "profile",
          expert: "profile",
          objective: "确认记忆",
          dependsOn: [],
        },
      ],
    }),
    call("knowledge_read", { id: "rule:profile" }),
    call("memory_propose", {
      namespace: "profile",
      key: "review",
      value: "需完善行为证据",
      evidenceIds: ["rule:profile"],
      expectedVersion: 0,
    }),
    call("expert_finish", {
      status: "needs_input",
      summary: "请补充行为证据",
      evidenceIds: ["rule:profile"],
      unknowns: ["行为证据"],
      conflicts: [],
      nextActions: [],
      artifact: {},
    }),
    answer,
  ];
}

test("user corrections and retractions are versioned, idempotent, scoped and invalidate old contexts", () => {
  const s = new Store(":memory:");
  try {
    seed(s);
    const old = runtime(s).create(request);
    s.propose(old.id, {
      namespace: "shared",
      key: "city",
      value: "旧值复活",
      evidenceIds: ["old"],
      expectedVersion: 1,
    });
    const other = runtime(s).create({ ...request, userId: "other-owner" });
    const corrected = s.changeMemory(request.userId, correction);
    assert.equal(corrected.version, 2);
    assert.equal(s.memories(request.userId, "report")[0]!.value, "成都");
    assert.equal(s.run(old.id).status, "stale");
    assert.equal(s.proposals(old.id)[0]!.status, "superseded");
    assert.equal(s.run(other.id).status, "created");
    assert.throws(() => s.commitMemories(old.id), /stale/);
    assert.deepEqual(s.changeMemory(request.userId, correction), corrected);
    assert.throws(
      () => s.changeMemory(request.userId, { ...correction, value: "篡改" }),
      /Operation ID/,
    );
    assert.throws(
      () => s.changeMemory("other-owner", correction),
      /version conflict/,
    );
    const fresh = runtime(s).create(request);
    s.changeMemory(request.userId, retraction);
    assert.equal(s.memories(request.userId, "report").length, 0);
    assert.equal(s.memoryHeads(request.userId)[0]!.state, "retracted");
    assert.equal(s.memoryHeads(request.userId)[0]!.version, 3);
    assert.equal(s.run(fresh.id).status, "stale");
    const after = runtime(s).create(request);
    s.propose(after.id, {
      namespace: "shared",
      key: "city",
      value: "旧值",
      evidenceIds: ["old"],
      expectedVersion: 0,
    });
    assert.throws(() => s.commitMemories(after.id), /version conflict/);
    assert.deepEqual(
      s.memoryHistory(request.userId).map((h) => h.version),
      [1, 2, 3],
    );
    s.forgetUser(request.userId);
    assert.deepEqual(s.memoryHistory(request.userId), []);
    assert.deepEqual(s.memoryHeads(request.userId), []);
    assert.equal(
      s.db
        .prepare("SELECT COUNT(*) n FROM memory_commands WHERE user_id=?")
        .get(request.userId)!.n,
      0,
    );
    assert.ok(s.run(other.id));
  } finally {
    s.close();
  }
});

test("memory batch conflict rolls back all writes and audit rows; retraction needs explicit approval", () => {
  const s = new Store(":memory:");
  try {
    seed(s);
    const r = runtime(s).create(request);
    s.propose(r.id, {
      namespace: "shared",
      key: "new",
      value: "should roll back",
      evidenceIds: ["source"],
      expectedVersion: 0,
    });
    s.propose(r.id, {
      namespace: "shared",
      key: "city",
      value: "conflicting",
      evidenceIds: ["source"],
      expectedVersion: 0,
    });
    assert.throws(() => s.commitMemories(r.id), /version conflict/);
    assert.equal(s.memoryHistory(request.userId).length, 1);
    assert.equal(s.memoryHeads(request.userId).length, 1);
    assert.ok(s.proposals(r.id).every((p) => p.status === "pending"));
    s.rejectMemories(r.id);
    s.propose(r.id, {
      operation: "retract",
      namespace: "shared",
      key: "city",
      evidenceIds: ["user:retract"],
      expectedVersion: 1,
    });
    assert.equal(s.memories(request.userId, "profile").length, 1);
    const receipt = s.prepareApproval(r.id);
    s.decideApproval(r.id, receipt.approvalId, "approve");
    assert.equal(s.memories(request.userId, "profile").length, 0);
    assert.equal(s.memoryHeads(request.userId)[0]!.version, 2);
    assert.deepEqual(
      s.decideApproval(r.id, receipt.approvalId, "approve"),
      s.approval(r.id),
    );
    assert.throws(
      () => s.decideApproval(r.id, receipt.approvalId, "reject"),
      /different decision/,
    );
  } finally {
    s.close();
  }
});

test("expiry invalidates a running memory snapshot and expired proposals cannot be approved", (t) => {
  t.mock.timers.enable({
    apis: ["Date"],
    now: new Date("2026-01-01T00:00:00.000Z"),
  });
  const s = new Store(":memory:");
  try {
    seed(s);
    s.db
      .prepare("UPDATE memories SET expires_at=? WHERE user_id=?")
      .run("2026-01-01T00:00:01.000Z", request.userId);
    const r = runtime(s).create(request);
    // Advance the clock, without changing any persisted memory/version fields.
    t.mock.timers.tick(2000);
    assert.throws(() => s.assertCurrent(r), /expired/);
    assert.equal(s.run(r.id).status, "stale");
    assert.equal(s.memoryHeads(request.userId)[0]!.state, "expired");
    const fresh = runtime(s).create(request);
    s.propose(fresh.id, {
      namespace: "profile",
      key: "expired",
      value: "old",
      evidenceIds: ["source"],
      expectedVersion: 0,
      expiresAt: "2000-01-01T00:00:00.000Z",
    });
    const receipt = s.prepareApproval(fresh.id);
    assert.throws(
      () => s.decideApproval(fresh.id, receipt.approvalId, "approve"),
      /expired/,
    );
    assert.equal(s.approval(fresh.id)!.status, "pending");
  } finally {
    s.close();
  }
});

test("memory recall publishes versioned evidence only for allowed namespaces", async () => {
  const s = new Store(":memory:");
  try {
    seed(s);
    const k = new Knowledge(data),
      r = runtime(s).create(request);
    s.propose(r.id, {
      namespace: "profile",
      key: "private",
      value: "画像私有事实",
      evidenceIds: ["resume:1"],
      expectedVersion: 0,
    });
    s.commitMemories(r.id);
    const t = new DomainTools(
      "match",
      r,
      "match",
      s,
      k,
      [],
      new AbortController().signal,
    );
    const result = await t.invoke("memory_recall", {}, "recall");
    assert.ok(JSON.stringify(result).includes("memory:shared:city:v1"));
    assert.ok(!JSON.stringify(result).includes("画像私有事实"));
    t.assertEvidence(["memory:shared:city:v1"]);
    assert.throws(
      () => t.assertEvidence(["memory:profile:private:v1"]),
      /Unread/,
    );
  } finally {
    s.close();
  }
});

test("approval snapshot rejects new proposals and failed expert sources", () => {
  const s = new Store(":memory:");
  try {
    const r = runtime(s).create(request);
    s.propose(r.id, {
      namespace: "profile",
      key: "a",
      value: "first",
      evidenceIds: ["source"],
      expectedVersion: 0,
    });
    const receipt = s.prepareApproval(r.id);
    s.propose(r.id, {
      namespace: "profile",
      key: "b",
      value: "not reviewed",
      evidenceIds: ["source"],
      expectedVersion: 0,
    });
    assert.throws(
      () => s.decideApproval(r.id, receipt.approvalId, "approve"),
      /snapshot changed/,
    );
    assert.equal(s.memories(request.userId, "profile").length, 0);
    const failed = runtime(s).create(request);
    s.propose(
      failed.id,
      {
        namespace: "profile",
        key: "c",
        value: "no artifact",
        evidenceIds: ["source"],
        expectedVersion: 0,
      },
      { stepId: "profile", attempt: 1 },
    );
    assert.throws(() => s.commitMemories(failed.id), /source attempt/);
  } finally {
    s.close();
  }
});

for (const decision of ["approve", "reject"] as const) {
  test(`durable ${decision} receipt survives commit/checkpoint failure without duplicate memory or approval`, async () => {
    mkdirSync(resolve(ROOT, "var/tests"), { recursive: true });
    const db = resolve(
      mkdtempSync(resolve(ROOT, "var/tests/memory-")),
      "runs.sqlite",
    );
    let s = new Store(db);
    const provider = new ReplayProvider(approvalFixture()),
      cfg = config();
    let rt = new Runtime(s, new Knowledge(data), provider, cfg);
    const r = rt.create(request);
    try {
      assert.equal(
        (await rt.execute(r.id, request.userId)).status,
        "waiting_approval",
      );
      const receipt = s.approval(r.id)!;
      const commit = s.decideApproval.bind(s);
      s.decideApproval = (...args) => {
        commit(...args);
        throw new Error("Injected crash after approval commit");
      };
      const interrupted = await rt.execute(r.id, request.userId, {
        approvalId: receipt.approvalId,
        decision,
      });
      assert.equal(interrupted.status, "failed");
      assert.match(interrupted.error!, /Injected/);
      s.close();
      s = new Store(db);
      rt = new Runtime(s, new Knowledge(data), provider, cfg);
      const restored = await rt.execute(r.id, request.userId);
      assert.equal(
        restored.status,
        decision === "approve" ? "partial" : "rejected",
        restored.error,
      );
      assert.equal(s.approval(r.id)!.approvalId, receipt.approvalId);
      assert.equal(
        s.events(r.id).filter((e) => e.type === "approval.required").length,
        1,
      );
      assert.equal(
        s.memoryHistory(request.userId).length,
        decision === "approve" ? 1 : 0,
      );
      assert.equal(s.modelCalls(r.id).length, decision === "approve" ? 5 : 4);
    } finally {
      s.close();
    }
  });
}

test("corrected memory and changed resume prevent old successful artifacts from being reused", async () => {
  const s = new Store(":memory:");
  try {
    const prior = seed(s);
    s.saveArtifact({
      id: `${prior.id}:profile`,
      runId: prior.id,
      stepId: "profile",
      expert: "profile",
      version: prior.constraintVersion,
      result: {
        status: "succeeded",
        summary: "OLD_ARTIFACT_CANARY",
        evidenceIds: [],
        unknowns: [],
        conflicts: [],
        nextActions: [],
        artifact: {},
      },
    });
    s.changeMemory(request.userId, correction);
    const rt = runtime(s, [
      call("plan_submit", {
        rationale: "新画像",
        steps: [
          { id: "profile", expert: "profile", objective: "new", dependsOn: [] },
        ],
      }),
      call("expert_finish", {
        status: "needs_input",
        summary: "新事实",
        evidenceIds: [],
        unknowns: [],
        conflicts: [],
        nextActions: [],
        artifact: {},
      }),
      answer,
    ]);
    const fresh = rt.create({ ...request, resumeText: "新简历" });
    assert.equal(
      (await rt.execute(fresh.id, request.userId)).status,
      "partial",
    );
    assert.ok(
      !JSON.stringify(s.modelCalls(fresh.id)).includes("OLD_ARTIFACT_CANARY"),
    );
    assert.ok(
      JSON.stringify(s.modelCalls(fresh.id)[0]!.messages).includes("成都"),
    );
  } finally {
    s.close();
  }
});
