import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { Store } from "../src/storage.js";
import { Runtime, EXECUTION_STATE_PREFIX } from "../src/runtime.js";
import { DomainTools, EvidenceRequiredError } from "../src/tools.js";
import { InputHistoryTools } from "../src/input-history-tools.js";
import { conversationInputs } from "../src/conversation-inputs.js";
import { followUpInput, continuationContext } from "../src/follow-up.js";
import { Knowledge } from "../src/retrieval.js";
import { loadDataset } from "../src/data.js";
import { ReplayProvider } from "../src/providers.js";
import { Dimensions, FollowUp, type ModelReply } from "../src/contracts.js";
import { ROOT, hash } from "../src/config.js";
import { config } from "./test-config.js";

const knowledge = new Knowledge(
  loadDataset(resolve(ROOT, "data/synthetic/dataset.json")),
);
const cfg = {
  ...config(),
  maxPlanningTurns: 20,
  maxCalls: 120,
  maxInputTokens: 8000000,
  maxContextTokens: 96000,
  activeContextTarget: 18000,
};
const call = (
  name: string,
  args: unknown,
  id = randomUUID(),
): { reply: ModelReply } => ({
  reply: {
    message: {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id,
          type: "function",
          function: { name, arguments: JSON.stringify(args) },
        },
      ],
    },
    usage: { input: 10, output: 10, cachedInput: 0 },
    finishReason: "tool_calls",
  },
});
const answer = {
  reply: {
    message: {
      role: "assistant" as const,
      content: "按原任务核验，保留当前更正。",
    },
    usage: { input: 10, output: 10, cachedInput: 0 },
    finishReason: "stop",
  },
};
const plan = call("plan_submit", {
  rationale: "历史原任务是核验项目能力，本轮维持此目标",
  steps: [
    {
      id: "profile",
      expert: "profile",
      objective: "核验TypeScript项目证据，核对更正",
      dependsOn: [],
    },
  ],
});
function makeChain(store: Store, architecture: "multi-agent" | "skills") {
  const runtime = new Runtime(store, knowledge, new ReplayProvider([]), cfg);
  const root = runtime.create({
    userId: "u",
    conversationId: "c",
    architecture,
    request:
      "原任务：核验TypeScript项目能力。独立完成TypeScript项目。" +
      "这是一段项目材料，需按原文核验。".repeat(1700),
  });
  let current = root;
  for (let i = 1; i <= 9; i++) {
    store.update(current.id, { status: "partial" });
    current = runtime.reply(current.id, "u", {
      operationId: `turn-${i}`,
      reply:
        i === 9
          ? "继续前面任务。更正：当前目标城市是西安。"
          : `第${i}轮记录。` + "补充实际项目过程，核对责任与证据。".repeat(800),
      ...(i === 9 ? { constraints: { cities: ["西安"] } } : {}),
    });
  }
  return { root, current };
}

for (const architecture of ["multi-agent", "skills"] as const) {
  test(`${architecture}: >40k raw history executes with real planner reads, repeated compaction and separately scoped expert evidence`, async () => {
    const store = new Store(":memory:");
    try {
      const { root, current } = makeChain(store, architecture);
      const history = conversationInputs(store.db, current.id, "u");
      assert(history.turns.reduce((n, t) => n + t.text.length, 0) > 100000);
      assert.equal(
        current.request.request,
        "继续前面任务。更正：当前目标城市是西安。",
      );
      assert.equal(store.run(root.id).request.request, root.request.request);
      const sourceId = history.turns[0]!.sourceId,
        intermediate = history.turns[4]!.sourceId;
      const sequence = [
        call("input_history_list", {}),
        ...[0, 8000, 16000, 24000].map((offset) =>
          call("input_history_read", { sourceId, offset, maxChars: 8000 }),
        ),
        ...[0, 8000].map((offset) =>
          call("input_history_read", {
            sourceId: intermediate,
            offset,
            maxChars: 8000,
          }),
        ),
        plan,
        call("input_history_read", { sourceId, offset: 0, maxChars: 200 }),
        call("profile_score", {
          observations: [
            {
              dimension: "professionalSkill",
              level: 2,
              confidence: 1,
              evidenceId: sourceId,
              quote: "独立完成TypeScript项目。",
              rationale: "已读历史项目原文",
              basis: "behavior",
            },
          ],
        }),
        call("expert_finish", {
          status: "partial",
          summary: "历史项目可核验，其他维度未知",
          evidenceIds: [sourceId],
          unknowns: ["其他维度缺少信息"],
          conflicts: [],
          nextActions: [],
          artifact: {
            scores: Object.fromEntries(
              Dimensions.map((d) => [d, d === "professionalSkill" ? 50 : null]),
            ),
            skills: ["TypeScript"],
            evidence: [
              {
                dimension: "professionalSkill",
                evidenceId: sourceId,
                quote: "独立完成TypeScript项目。",
              },
            ],
          },
        }),
        answer,
      ];
      const runtime = new Runtime(
        store,
        knowledge,
        new ReplayProvider(sequence),
        cfg,
      );
      const result = await runtime.execute(current.id, "u");
      assert.equal(
        result.status,
        "partial",
        JSON.stringify(
          store.events(current.id).filter((e) => /failed/.test(e.type)),
        ),
      );
      assert.equal(
        (
          store.artifacts(current.id)[0]!.result.artifact.scores as Record<
            string,
            number | null
          >
        ).professionalSkill,
        50,
      );
      const calls = store.modelCalls(current.id);
      const planned = calls.filter((c) => String(c.scope).startsWith("plan:"));
      assert.equal(planned.length, 8);
      assert(
        store.events(current.id).filter((e) => e.type === "context.compacted")
          .length >= 3,
      );
      assert(
        planned.some((c) =>
          JSON.stringify(c.messages).includes("WORKING_SET_V1"),
        ),
      );
      const lastPlanState = planned.at(-1)!.executionState as any;
      assert.equal(lastPlanState.inputHistory.totalReadPages, 6);
      assert.equal(lastPlanState.inputVersion, 9);
      const expert = calls.find(
        (c) => String(c.scope) === "expert:profile:turn:0",
      )!;
      assert.equal(
        (expert.executionState as any).inputHistory.totalReadPages,
        0,
      );
      assert.equal(
        (
          calls.find((c) => String(c.scope) === "expert:profile:turn:1")!
            .executionState as any
        ).inputHistory.totalReadPages,
        1,
      );
      assert.deepEqual(result.request.constraints.cities, ["西安"]);
      assert.equal(
        (store.artifacts(current.id)[0]!.publishedEvidence ?? []).find(
          (e) => e.id === sourceId,
        )!.text.length,
        200,
      );
      assert(
        planned.every((c) =>
          (c.messages as any[]).some((m) =>
            m.content?.startsWith(EXECUTION_STATE_PREFIX),
          ),
        ),
      );
    } finally {
      store.close();
    }
  });
}

test("history metadata cannot score, unread ranges cannot quote, and reads/recovery stay role and attempt scoped", async () => {
  const store = new Store(":memory:");
  try {
    const { current } = makeChain(store, "multi-agent");
    const tools = new DomainTools(
      "profile",
      current,
      "p",
      store,
      knowledge,
      [],
      new AbortController().signal,
    );
    const listed = (await tools.invoke(
      "input_history_list",
      {},
      "list",
    )) as any;
    const id = listed.entries[0].sourceId;
    assert.equal(tools.seen.size, 0);
    const score = {
      observations: [
        {
          dimension: "professionalSkill",
          level: 2,
          confidence: 1,
          evidenceId: id,
          quote: "独立完成TypeScript项目。",
          rationale: "引用原文",
          basis: "behavior",
        },
      ],
    };
    await assert.rejects(
      tools.invoke("profile_score", score, "unread"),
      EvidenceRequiredError,
    );
    await tools.invoke(
      "input_history_read",
      { sourceId: id, offset: 1000, maxChars: 200 },
      "far",
    );
    await assert.rejects(
      tools.invoke("profile_score", score, "gap"),
      /quote mismatch/,
    );
    await tools.invoke(
      "input_history_read",
      { sourceId: id, offset: 0, maxChars: 200 },
      "start",
    );
    await tools.invoke("profile_score", score, "score");
    const restored = new DomainTools(
      "profile",
      current,
      "p",
      store,
      knowledge,
      [],
      new AbortController().signal,
    );
    await restored.invoke(
      "input_history_read",
      { sourceId: id, offset: 0, maxChars: 200 },
      "replay",
    );
    assert.equal(restored.executionState().inputHistory.totalReadPages, 2);
    const other = new DomainTools(
      "match",
      current,
      "m",
      store,
      knowledge,
      [],
      new AbortController().signal,
    );
    assert.equal(other.executionState().inputHistory.totalReadPages, 0);
    assert.equal(
      new DomainTools(
        "profile",
        current,
        "p@2",
        store,
        knowledge,
        [],
        new AbortController().signal,
      ).executionState().inputHistory.totalReadPages,
      0,
    );
    await assert.rejects(
      tools.invoke(
        "input_history_read",
        { sourceId: id.replace(current.id, "foreign") },
        "foreign",
      ),
      /outside/,
    );
    await assert.rejects(
      tools.invoke("knowledge_read", { id }, "bypass"),
      /Use input_history_read/,
    );
    const foreignId = id.replace(current.id, "foreign");
    const delegated = new DomainTools(
      "report",
      current,
      "delegated",
      store,
      knowledge,
      [
        {
          id: "upstream",
          runId: current.id,
          stepId: "profile",
          expert: "profile",
          version: 1,
          result: {
            status: "partial",
            summary: "历史引用",
            evidenceIds: [foreignId],
            unknowns: [],
            conflicts: [],
            nextActions: [],
            artifact: {},
          },
          publishedEvidence: [
            {
              id: foreignId,
              sourceId: foreignId,
              kind: "request",
              version: hash("foreign"),
              text: "foreign",
            },
          ],
        },
      ],
      new AbortController().signal,
    );
    await assert.rejects(
      delegated.invoke("knowledge_read", { id: foreignId }, "foreign-grant"),
      /another run view/,
    );
    const entry = store.cacheEntries(
      current.id,
      "execution:p:profile:history-read:",
    )[0]!.value as any;
    store.db
      .prepare("UPDATE tool_cache SET result=? WHERE run_id=? AND key=?")
      .run(JSON.stringify({ tampered: true }), current.id, entry.cacheKey);
    assert.throws(() => restored.executionState(), /receipt_mismatch/);
  } finally {
    store.close();
  }
});

test("legacy v1 reconstruction remains exact and can precede a v2 child without rewriting sealed user inputs", () => {
  const store = new Store(":memory:");
  try {
    const runtime = new Runtime(store, knowledge, new ReplayProvider([]), cfg);
    const root = runtime.create({
      userId: "legacy",
      conversationId: "c",
      request: "旧原始目标",
    });
    store.update(root.id, { status: "partial" });
    const command = FollowUp.parse({ operationId: "old", reply: "旧原始补充" });
    const old = store.followUp(
      "legacy",
      root.id,
      command.operationId,
      hash(command),
      (parent) => ({
        run: {
          ...parent,
          id: randomUUID(),
          status: "created",
          ...followUpInput(parent, command, [], "user-reply-v1"),
        },
        metadata: {},
      }),
    );
    const frozen = JSON.stringify(store.run(old.id));
    assert(old.request.request.includes(root.request.request));
    assert.deepEqual(
      conversationInputs(store.db, old.id, "legacy").turns.map((t) => t.text),
      ["旧原始目标", "旧原始补充"],
    );
    store.update(old.id, { status: "partial" });
    const child = runtime.reply(old.id, "legacy", {
      operationId: "new",
      reply: "新轮次",
    });
    assert.equal(child.request.request, "新轮次");
    assert.deepEqual(
      conversationInputs(store.db, child.id, "legacy").turns.map((t) => t.text),
      ["旧原始目标", "旧原始补充", "新轮次"],
    );
    assert.equal(
      JSON.parse(frozen).request.request,
      store.run(old.id).request.request,
    );
  } finally {
    store.close();
  }
});

test("current raw history pages can resolve a question and propose memory, while old absence cannot become a current zero", async () => {
  const store = new Store(":memory:");
  try {
    const runtime = new Runtime(store, knowledge, new ReplayProvider([]), cfg);
    const parent = runtime.create({
      userId: "personal-history",
      conversationId: "c",
      request: "暂无企业实习。",
    });
    store.saveArtifact({
      id: "question",
      runId: parent.id,
      stepId: "profile",
      expert: "profile",
      version: 1,
      result: {
        status: "needs_input",
        summary: "请补充目标城市",
        evidenceIds: [],
        unknowns: ["目标城市是哪里？"],
        conflicts: [],
        nextActions: [],
        artifact: {},
      },
    });
    store.update(parent.id, { status: "partial" });
    const child = runtime.reply(parent.id, "personal-history", {
      operationId: "new",
      reply: "目标城市是西安。暂无企业实习。",
      constraints: { cities: ["西安"] },
    });
    const tools = new DomainTools(
      "profile",
      child,
      "profile",
      store,
      knowledge,
      [],
      new AbortController().signal,
    );
    const oldId = `input:${child.id}:turn:0:request`,
      currentId = `input:${child.id}:turn:1:request`;
    await tools.invoke("input_history_read", { sourceId: oldId }, "old");
    const observation = {
      dimension: "internship",
      level: 0,
      confidence: 1,
      evidenceId: oldId,
      quote: "暂无企业实习",
      rationale: "明确自述",
      basis: "explicit_absence",
    };
    await assert.rejects(
      tools.invoke(
        "profile_score",
        { observations: [observation] },
        "old-zero",
      ),
      /Explicit absence/,
    );
    await tools.invoke(
      "input_history_read",
      { sourceId: currentId },
      "current",
    );
    const score = (await tools.invoke(
      "profile_score",
      { observations: [{ ...observation, evidenceId: currentId }] },
      "current-zero",
    )) as any;
    assert.equal(score.scores.internship, 0);
    await tools.invoke("input_read", { source: "request" }, "request");
    await tools.invoke("input_read", { source: "resume" }, "resume");
    const updated = (await tools.invoke(
      "clarification_update",
      {
        updates: [
          {
            questionId: continuationContext(child, "profile")!.questions[0]!
              .questionId,
            expectedVersion: 0,
            status: "answered",
            claims: [
              {
                subject: "user",
                text: "目标城市是西安",
                citations: [{ evidenceId: currentId, quote: "目标城市是西安" }],
              },
            ],
            remaining: [],
            reason: "读取本轮用户原文",
          },
        ],
      },
      "resolve",
    )) as any;
    assert.equal(updated.current[0].status, "answered");
    const proposed = (await tools.invoke(
      "memory_propose",
      {
        namespace: "shared",
        key: "city",
        value: "西安",
        evidenceIds: [currentId],
        expectedVersion: 0,
      },
      "propose",
    )) as any;
    assert.equal(proposed.status, "pending_approval");
    assert.equal(store.memoryHeads("personal-history").length, 0);
    const downstream = new DomainTools(
      "report",
      child,
      "report",
      store,
      knowledge,
      [],
      new AbortController().signal,
    );
    assert.equal(downstream.seen.has(currentId), false);
    await downstream.invoke(
      "input_history_read",
      { sourceId: currentId },
      "downstream",
    );
    assert.equal(downstream.seen.get(currentId)!.text, child.request.request);
  } finally {
    store.close();
  }
});

for (const architecture of ["multi-agent", "skills"] as const) {
  for (const boundary of ["planner-response", "planner-read", "expert-read"]) {
    test(`${architecture}: actual SIGKILL at ${boundary} recovers raw history reads without duplicate model calls or role grants`, () => {
      mkdirSync(resolve(ROOT, "var/tests"), { recursive: true });
      const dir = mkdtempSync(resolve(ROOT, "var/tests/history-recovery-")),
        db = resolve(dir, "runs.sqlite"),
        fixture = resolve(dir, "replay.json");
      const store = new Store(db);
      let runId: string;
      try {
        const runtime = new Runtime(store, knowledge, new ReplayProvider([]), {
          ...config(),
          leaseTtlMs: 1000,
        });
        const parent = runtime.create({
          userId: "recover-history",
          conversationId: "c",
          architecture,
          request: "原目标：核验项目",
        });
        store.update(parent.id, { status: "partial" });
        const child = runtime.reply(parent.id, "recover-history", {
          operationId: "continue",
          reply: "继续",
        });
        runId = child.id;
        const sourceId = `input:${child.id}:turn:0:request`;
        writeFileSync(
          fixture,
          JSON.stringify(
            [
              call("input_history_read", { sourceId }),
              plan,
              call("input_history_read", { sourceId }),
              call("expert_finish", {
                status: "needs_input",
                summary: "请补充具体项目",
                evidenceIds: [sourceId],
                unknowns: ["项目职责"],
                conflicts: [],
                nextActions: [],
                artifact: {},
              }),
              answer,
            ],
            null,
            2,
          ),
        );
      } finally {
        store.close();
      }
      for (const mode of ["crash", "recover"]) {
        const child = spawnSync(
          process.execPath,
          [
            resolve(ROOT, "dist/tests/fixtures/history-worker.js"),
            db,
            runId!,
            fixture,
            boundary,
            mode,
          ],
          { encoding: "utf8", timeout: 20000, windowsHide: true },
        );
        writeFileSync(
          resolve(dir, `${mode}.json`),
          JSON.stringify(
            {
              status: child.status,
              signal: child.signal,
              stdout: child.stdout,
              stderr: child.stderr,
              error: child.error?.message,
            },
            null,
            2,
          ),
        );
        assert.equal(child.error, undefined);
        if (mode === "crash") {
          assert.notEqual(child.status, 0);
          assert.match(child.stdout, /HISTORY_BOUNDARY_SAVED/);
        } else assert.equal(child.status, 0, child.stderr);
      }
      const recovered = new Store(db);
      try {
        assert.deepEqual(
          recovered.modelCalls(runId!).map((c) => c.scope),
          [
            "plan:0",
            "plan:1",
            "expert:profile:turn:0",
            "expert:profile:turn:1",
            "synthesize",
          ],
        );
        if (boundary !== "expert-read")
          assert(
            recovered.events(runId!).some((e) => e.type === "model.recovered"),
          );
        else
          assert(
            recovered
              .events(runId!)
              .some(
                (e) =>
                  e.type === "tool.completed" &&
                  e.expert === "profile" &&
                  (e.payload as any).name === "input_history_read" &&
                  (e.payload as any).replayed === true,
              ),
          );
        const current = recovered.run(runId!);
        assert.equal(
          new InputHistoryTools(
            recovered,
            current,
            "plan",
            "orchestrator",
          ).state().totalReadPages,
          1,
        );
        assert.equal(
          new InputHistoryTools(
            recovered,
            current,
            "profile",
            "profile",
          ).state().totalReadPages,
          1,
        );
        assert.equal(
          new InputHistoryTools(recovered, current, "match", "match").state()
            .totalReadPages,
          0,
        );
        assert.equal(recovered.listRuns("recover-history").length, 2);
      } finally {
        recovered.close();
      }
    });
  }
}
