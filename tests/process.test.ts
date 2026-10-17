import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { Store } from "../src/storage.js";
import { Runtime } from "../src/runtime.js";
import { Knowledge } from "../src/retrieval.js";
import { ReplayProvider } from "../src/providers.js";
import { loadDataset } from "../src/data.js";
import { ROOT } from "../src/config.js";
import { config } from "./test-config.js";
import { Request, type ModelReply } from "../src/contracts.js";
import { SqliteSaver } from "../src/checkpointer.js";
import { emptyCheckpoint } from "@langchain/langgraph-checkpoint";
import { runMetrics } from "../src/evaluation.js";

const cfg = { ...config(), leaseTtlMs: 1500 };
const request = Request.parse({
  userId: "process-user",
  conversationId: "c",
  request: "测试进程恢复",
});
const knowledge = () =>
  new Knowledge(loadDataset(resolve(ROOT, "data/synthetic/dataset.json")));
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
const finish: { reply: ModelReply } = {
  reply: {
    message: { role: "assistant", content: "恢复完成，缺少简历。" },
    usage: { input: 10, output: 10, cachedInput: 0 },
    finishReason: "stop",
  },
};
function fixtures() {
  return [
    call("plan_submit", {
      rationale: "画像",
      steps: [
        { id: "profile", expert: "profile", objective: "画像", dependsOn: [] },
      ],
    }),
    call("knowledge_read", { id: "rule:profile" }),
    call("memory_propose", {
      namespace: "profile",
      key: "pending",
      value: "需要简历证据",
      evidenceIds: ["rule:profile"],
      expectedVersion: 0,
    }),
    call("expert_finish", {
      status: "needs_input",
      summary: "需要简历",
      evidenceIds: ["rule:profile"],
      unknowns: [],
      conflicts: [],
      nextActions: [],
      artifact: {},
    }),
  ];
}
function file() {
  mkdirSync(resolve(ROOT, "var/tests"), { recursive: true });
  return resolve(
    mkdtempSync(resolve(ROOT, "var/tests/process-")),
    "runs.sqlite",
  );
}
function worker(db: string, id: string, mode: string, approvalId = "") {
  return spawn(
    process.execPath,
    [
      resolve(ROOT, "dist/tests/fixtures/process-worker.js"),
      db,
      id,
      request.userId,
      mode,
      approvalId,
    ],
    { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  );
}
async function exited(child: ChildProcess) {
  let stderr = "";
  child.stderr?.on("data", (data) => {
    stderr += String(data);
  });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 10000);
  try {
    const [code, signal] = await once(child, "exit");
    return { code, signal, stderr };
  } finally {
    clearTimeout(timeout);
  }
}

for (const architecture of ["multi-agent", "skills"] as const) {
  test(
    `${architecture}: SIGKILL after a stream frame preserves partial data without executing incomplete tool arguments`,
    { timeout: 15000 },
    async () => {
      const db = file();
      let s = new Store(db);
      const r = new Runtime(s, knowledge(), new ReplayProvider([]), cfg).create(
        { ...request, architecture, approvalRequired: true },
      );
      const fixture = db + ".fixture.json";
      writeFileSync(fixture, JSON.stringify(fixtures()));
      s.close();
      const stopped = await exited(worker(db, r.id, "stream-frame", fixture));
      assert.notEqual(stopped.code, 0, stopped.stderr);
      s = new Store(db);
      assert.equal(s.modelCalls(r.id).length, 1);
      assert.equal(s.modelCalls(r.id)[0]!.status, "started");
      assert.equal(
        s.events(r.id).filter((e) => e.type === "model.stream").length,
        1,
      );
      assert.equal(s.artifacts(r.id).length, 0);
      assert.equal(s.proposals(r.id).length, 0);
      s.close();
      await delay(1800);
      s = new Store(db);
      try {
        const done = await new Runtime(
          s,
          knowledge(),
          new ReplayProvider(fixtures()),
          cfg,
        ).execute(r.id, request.userId);
        assert.equal(done.status, "waiting_approval", done.error);
        const partial = s
          .modelCalls(r.id)
          .find((c) => c.status === "interrupted")!;
        assert.equal(
          (partial.partialResponse as any).content,
          "durable partial text",
        );
        assert.equal(
          (partial.partialResponse as any).tool_calls[0].function.arguments,
          '{"rationale":',
        );
        assert.equal(partial.streamFrames, 1);
        assert.equal(runMetrics(s, r.id).modelCalls, 5);
        assert.equal(runMetrics(s, r.id).inputTokens, null);
        assert.equal(s.proposals(r.id).length, 1);
      } finally {
        s.close();
      }
    },
  );
  for (const boundary of [
    "model-before",
    "model-after",
    "proposal-before",
    "proposal-after",
    "tool-cache-before",
    "tool-cache-after",
  ] as const) {
    test(
      `${architecture}: kill ${boundary} preserves known response and idempotent tool effects`,
      { timeout: 15000 },
      async () => {
        const db = file();
        let s = new Store(db);
        const r = new Runtime(
          s,
          knowledge(),
          new ReplayProvider([]),
          cfg,
        ).create({ ...request, architecture, approvalRequired: true });
        const fixture = db + ".fixture.json";
        writeFileSync(fixture, JSON.stringify(fixtures()));
        s.close();
        const stopped = await exited(worker(db, r.id, boundary, fixture));
        assert.notEqual(stopped.code, 0, stopped.stderr);
        s = new Store(db);
        const modelBoundary = boundary.startsWith("model-");
        assert.equal(
          s.modelCalls(r.id).length,
          modelBoundary ? 2 : 3,
          stopped.stderr,
        );
        assert.equal(
          s.proposals(r.id).length,
          modelBoundary || boundary === "proposal-before" ? 0 : 1,
        );
        s.close();
        await delay(1800);
        s = new Store(db);
        try {
          const remaining = fixtures().slice(
            boundary === "model-before"
              ? 1
              : boundary === "model-after"
                ? 2
                : 3,
          );
          const done = await new Runtime(
            s,
            knowledge(),
            new ReplayProvider(remaining),
            cfg,
          ).execute(r.id, request.userId);
          assert.equal(done.status, "waiting_approval", done.error);
          assert.equal(s.proposals(r.id).length, 1);
          assert.equal(s.memoryHeads(request.userId).length, 0);
          const metrics = runMetrics(s, r.id);
          assert.equal(metrics.modelCalls, boundary === "model-before" ? 5 : 4);
          assert.equal(
            metrics.interruptedModelCalls,
            boundary === "model-before" ? 1 : 0,
          );
          if (boundary === "model-before")
            assert.equal(metrics.inputTokens, null);
          if (boundary === "model-after")
            assert.equal(metrics.recoveredModelReplies, 1);
          if (boundary === "tool-cache-after")
            assert(
              s
                .events(r.id)
                .some(
                  (e) =>
                    e.type === "tool.completed" &&
                    (e.payload as any).name === "memory_propose" &&
                    (e.payload as any).replayed,
                ),
            );
        } finally {
          s.close();
        }
      },
    );
  }
  for (const boundary of ["artifact-before", "artifact-after"] as const) {
    test(
      `${architecture}: actual kill ${boundary} reuses completed expert and commits no duplicate proposal`,
      { timeout: 15000 },
      async () => {
        const db = file();
        let s = new Store(db);
        const r = new Runtime(
          s,
          knowledge(),
          new ReplayProvider([]),
          cfg,
        ).create({ ...request, architecture, approvalRequired: true });
        const fixture = db + ".fixture.json";
        writeFileSync(fixture, JSON.stringify(fixtures()));
        s.close();
        const stopped = await exited(worker(db, r.id, boundary, fixture));
        assert.notEqual(stopped.code, 0, stopped.stderr);
        s = new Store(db);
        assert.equal(s.modelCalls(r.id).length, 4, stopped.stderr);
        assert.equal(
          s.artifacts(r.id).length,
          boundary === "artifact-before" ? 0 : 1,
        );
        assert.equal(s.proposals(r.id).length, 1);
        s.close();
        await delay(1800);
        s = new Store(db);
        try {
          const done = await new Runtime(
            s,
            knowledge(),
            new ReplayProvider([]),
            cfg,
          ).execute(r.id, request.userId);
          assert.equal(done.status, "waiting_approval", done.error);
          assert.equal(s.artifacts(r.id).length, 1);
          assert.equal(
            s.modelCalls(r.id).length,
            4,
            "completed expert must not call the model again",
          );
          assert.equal(s.proposals(r.id).length, 1);
          assert.equal(
            s.memoryHeads(request.userId).length,
            0,
            "pending proposal is not committed memory",
          );
        } finally {
          s.close();
        }
      },
    );
  }
  test(
    `${architecture}: actual kill after routing commit resumes the new plan without repeating coordination`,
    { timeout: 15000 },
    async () => {
      const db = file();
      let s = new Store(db);
      const rt = new Runtime(s, knowledge(), new ReplayProvider([]), cfg),
        r = rt.create({ ...request, architecture });
      const report = {
        id: "report",
        expert: "report",
        objective: "审阅",
        dependsOn: [] as string[],
      };
      const profile = {
        id: "profile",
        expert: "profile",
        objective: "补充画像",
        dependsOn: [] as string[],
      };
      const startup = [
        call("plan_submit", { rationale: "审阅", steps: [report] }),
        call("collaboration_request", {
          kind: "assistance",
          targetStepId: null,
          targetRole: "profile",
          question: "请补充画像",
          evidenceIds: [],
        }),
        call("coordination_decide", {
          action: "revise",
          reason: "补入画像",
          targetStepId: "profile",
          plan: {
            rationale: "修订",
            steps: [profile, { ...report, dependsOn: ["profile"] }],
          },
        }),
      ];
      const fixture = db + ".fixture.json";
      writeFileSync(fixture, JSON.stringify(startup));
      try {
        s.close();
        const exit = await exited(
          worker(db, r.id, "coordinate-after", fixture),
        );
        s = new Store(db);
        assert.notEqual(exit.code, 0, exit.stderr);
        assert.equal(s.run(r.id).status, "running", exit.stderr);
        assert.equal(
          s.artifacts(r.id).length,
          0,
          "old requester was invalidated in the committed revision",
        );
        assert.equal(
          s.events(r.id).filter((e) => e.type === "coordination.committed")
            .length,
          1,
        );
        const lease = s.db
          .prepare("SELECT expires FROM leases WHERE resource=?")
          .get(r.id)!;
        await delay(Math.max(1, Number(lease.expires) - Date.now() + 60));
        const result = {
          status: "needs_input",
          summary: "简历不足",
          evidenceIds: [],
          unknowns: ["缺少简历"],
          conflicts: [],
          nextActions: [],
          artifact: {},
        };
        const resumed = new Runtime(
          s,
          knowledge(),
          new ReplayProvider([
            call("expert_finish", result),
            call("expert_finish", result),
            finish,
          ]),
          cfg,
        );
        const done = await resumed.execute(r.id, request.userId);
        assert.equal(done.status, "partial", done.error);
        assert.equal(s.artifact(r.id, "profile")!.attempt, 1);
        assert.equal(s.artifact(r.id, "report")!.attempt, 2);
        assert.equal(s.modelCalls(r.id).length, 6);
        assert.equal(
          s.events(r.id).filter((e) => e.type === "coordination.committed")
            .length,
          1,
        );
      } finally {
        s.close();
      }
    },
  );
}

for (const mode of ["before", "after"] as const) {
  test(
    `actual process kill ${mode} approval commit resumes with exactly one memory version`,
    { timeout: 15000 },
    async () => {
      const db = file();
      let s = new Store(db);
      const rt = new Runtime(
          s,
          knowledge(),
          new ReplayProvider(fixtures()),
          cfg,
        ),
        r = rt.create(request);
      try {
        assert.equal(
          (await rt.execute(r.id, request.userId)).status,
          "waiting_approval",
        );
        const receipt = s.approval(r.id)!;
        s.close();
        const child = worker(db, r.id, mode, receipt.approvalId);
        const exit = await exited(child);
        s = new Store(db);
        assert.notEqual(exit.code, 0, exit.stderr);
        assert.equal(s.run(r.id).status, "running", exit.stderr);
        assert.equal(
          s.approval(r.id)!.status,
          mode === "after" ? "committed" : "pending",
          exit.stderr,
        );
        const lease = s.db
          .prepare("SELECT expires FROM leases WHERE resource=?")
          .get(r.id)!;
        assert.ok(lease, "abrupt kill bypasses finally/release");
        await delay(Math.max(1, Number(lease.expires) - Date.now() + 60));
        const restored = new Runtime(
          s,
          knowledge(),
          new ReplayProvider([finish]),
          cfg,
        );
        const done = await restored.execute(
          r.id,
          request.userId,
          mode === "before"
            ? { approvalId: receipt.approvalId, decision: "approve" }
            : undefined,
        );
        assert.equal(done.status, "partial", done.error);
        assert.equal(s.memoryHistory(request.userId).length, 1);
        assert.equal(s.memoryHeads(request.userId)[0]!.version, 1);
        assert.equal(
          s.events(r.id).filter((e) => e.type === "memory.committed").length,
          1,
        );
        assert.equal(
          s.events(r.id).filter((e) => e.type === "approval.required").length,
          1,
        );
        assert.equal(s.modelCalls(r.id).length, 5);
      } finally {
        s.close();
      }
    },
  );
}

test(
  "live competing process owns renewable lease and stale owner cannot overwrite replacement",
  { timeout: 15000 },
  async () => {
    const db = file(),
      s = new Store(db);
    let child: ChildProcess | undefined;
    try {
      const rt = new Runtime(s, knowledge(), new ReplayProvider([]), cfg),
        r = rt.create(request);
      child = worker(db, r.id, "hold");
      const ready = new Promise<void>((resolveReady, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("Worker readiness timed out")),
          5000,
        );
        child!.once("error", reject);
        child!.stdout!.on("data", (data) => {
          if (String(data).includes("LEASE_READY")) {
            clearTimeout(timeout);
            resolveReady();
          }
        });
      });
      await ready;
      await assert.rejects(
        rt.execute(r.id, request.userId),
        /already executing/,
      );
      assert.equal(s.modelCalls(r.id).length, 0);
      const stopped = once(child, "exit");
      child.kill("SIGKILL");
      await stopped;
      const lease = s.db
        .prepare("SELECT expires FROM leases WHERE resource=?")
        .get(r.id)!;
      await delay(Math.max(1, Number(lease.expires) - Date.now() + 60));
      s.lease(r.id, "replacement", 1000);
      s.assertCurrent(r);
      const other = new Store(db);
      try {
        // Force an expired ownership boundary without long timing-sensitive waits.
        s.db.prepare("UPDATE leases SET expires=0 WHERE resource=?").run(r.id);
        other.lease(r.id, "next-owner", 1000);
        assert.throws(() => s.assertCurrent(r), /lease lost/);
        assert.throws(
          () => s.renewLease(r.id, "replacement", 1000),
          /lease lost/,
        );
        await assert.rejects(
          new SqliteSaver(s).put(
            { configurable: { thread_id: `${r.id}::profile` } },
            emptyCheckpoint(),
            { source: "input", step: 0, parents: {} },
          ),
          /lease lost/,
        );
        assert.throws(() => s.update(r.id, { status: "failed" }), /lease lost/);
        s.release(r.id, "replacement");
        assert.equal(other.ownsLease(r.id, "next-owner"), true);
        other.release(r.id, "next-owner");
      } finally {
        other.close();
      }
    } finally {
      if (child && child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
      s.close();
    }
  },
);

for (const architecture of ["multi-agent", "skills"] as const)
  for (const boundary of ["checkpoint-before", "checkpoint-after"]) {
    test(
      `${architecture}: actual ${boundary} after proposal preserves one proposal and completed model responses`,
      { timeout: 15000 },
      async () => {
        const db = file();
        let s = new Store(db);
        const run = new Runtime(
          s,
          knowledge(),
          new ReplayProvider([]),
          cfg,
        ).create({ ...request, architecture, approvalRequired: true });
        const fixture = db + ".fixture.json";
        writeFileSync(fixture, JSON.stringify(fixtures()));
        s.close();
        const stopped = await exited(worker(db, run.id, boundary, fixture));
        assert.notEqual(stopped.code, 0, stopped.stderr);
        s = new Store(db);
        const marker = s
          .events(run.id)
          .find((e) => e.type === "test.checkpoint_boundary");
        assert.ok(marker, stopped.stderr);
        assert.equal(
          (marker.payload as any).stored,
          boundary === "checkpoint-after",
        );
        assert.equal(s.proposals(run.id).length, 1);
        const completed = s
          .modelCalls(run.id)
          .filter((c) => c.status === "completed").length;
        assert.ok(completed >= 3 && completed <= 4);
        s.close();
        await delay(1800);
        s = new Store(db);
        try {
          const done = await new Runtime(
            s,
            knowledge(),
            new ReplayProvider(fixtures().slice(completed)),
            cfg,
          ).execute(run.id, request.userId);
          assert.equal(done.status, "waiting_approval", done.error);
          assert.equal(s.proposals(run.id).length, 1);
          assert.equal(s.artifacts(run.id).length, 1);
          assert.equal(s.memoryHeads(request.userId).length, 0);
          assert.equal(runMetrics(s, run.id).modelCalls, 4);
          assert.equal(runMetrics(s, run.id).interruptedModelCalls, 0);
        } finally {
          s.close();
        }
      },
    );
  }
