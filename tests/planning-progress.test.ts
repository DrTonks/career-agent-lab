import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { Store } from "../src/storage.js";
import { Runtime } from "../src/runtime.js";
import { ReplayProvider } from "../src/providers.js";
import { Knowledge } from "../src/retrieval.js";
import { loadDataset } from "../src/data.js";
import { ROOT } from "../src/config.js";
import { PlanningProgress } from "../src/planning-progress.js";
import { config } from "./test-config.js";
import type { ModelReply } from "../src/contracts.js";
const knowledge = new Knowledge(
  loadDataset(resolve(ROOT, "data/synthetic/dataset.json")),
);
const call = (name: string, args: unknown): { reply: ModelReply } => ({
  reply: {
    message: {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: randomUUID(),
          type: "function",
          function: { name, arguments: JSON.stringify(args) },
        },
      ],
    },
    usage: { input: 10, output: 10, cachedInput: 0 },
    finishReason: "tool_calls",
  },
});
const plan = () =>
  call("plan_submit", {
    rationale: "材料只有占位符，安排画像专家核对并追问",
    steps: [
      {
        id: "profile",
        expert: "profile",
        objective: "核对材料并提出缺失项",
        dependsOn: [],
      },
    ],
  });
const finish = () => [
  call("input_read", { source: "request", offset: 0 }),
  call("input_read", { source: "resume", offset: 0 }),
  call("expert_finish", {
    status: "needs_input",
    summary: "仅占位材料，需要具体经历",
    evidenceIds: [],
    unknowns: ["具体经历"],
    conflicts: [],
    nextActions: [],
    artifact: {},
  }),
  {
    reply: {
      message: { role: "assistant" as const, content: "请补充具体经历" },
      usage: { input: 10, output: 10, cachedInput: 0 },
      finishReason: "stop",
    },
  },
];

test("planning progress counts new covered positions, empty reads once and query discovery; nested rereads do not advance", () => {
  const p = new PlanningProgress();
  const turn = (f: () => void) => {
    p.beginTurn();
    f();
    p.finishTurn();
  };
  turn(() => p.read("a", 0, 100));
  turn(() => p.read("a", 200, 300));
  turn(() => p.read("a", 10, 50));
  turn(() => p.read("a", 210, 250));
  assert.equal(p.state(4, 20).consecutiveTurnsWithoutNewHistory, 2);
  turn(() => p.read("a", 50, 220));
  assert.equal(p.state(5, 20).consecutiveTurnsWithoutNewHistory, 0);
  turn(() => p.read("empty", 0, 0));
  turn(() => p.read("empty", 0, 0));
  assert.equal(p.state(7, 20).consecutiveTurnsWithoutNewHistory, 1);
  turn(() => p.listed({ query: "目标" }));
  turn(() => p.listed({ query: "目标" }));
  assert.equal(p.state(9, 20).consecutiveTurnsWithoutNewHistory, 1);
});

for (const architecture of ["multi-agent", "skills"] as const) {
  test(`${architecture}: actual SIGKILL after closing-plan response rebuilds progress without duplicate model calls`, () => {
    mkdirSync(resolve(ROOT, "var/tests"), { recursive: true });
    const dir = mkdtempSync(resolve(ROOT, "var/tests/planning-close-")),
      db = resolve(dir, "runs.sqlite"),
      fixture = resolve(dir, "replay.json");
    const store = new Store(db);
    let id: string;
    try {
      const runtime = new Runtime(store, knowledge, new ReplayProvider([]), {
        ...config(),
        leaseTtlMs: 1000,
      });
      const parent = runtime.create({
        userId: "u",
        conversationId: "c",
        architecture,
        request: "占位材料",
      });
      store.update(parent.id, { status: "partial" });
      id = runtime.reply(parent.id, "u", {
        operationId: "c",
        reply: "核对原材料并追问",
      }).id;
      writeFileSync(
        fixture,
        JSON.stringify([
          ...Array.from({ length: 4 }, () =>
            call("input_history_read", {
              sourceId: `input:${id}:turn:0:request`,
            }),
          ),
          plan(),
          ...finish(),
        ]),
      );
    } finally {
      store.close();
    }
    for (const mode of ["crash", "recover"]) {
      const child = spawnSync(
        process.execPath,
        [
          resolve(ROOT, "dist/tests/fixtures/planning-close-worker.js"),
          db,
          id!,
          fixture,
          mode,
        ],
        { encoding: "utf8", timeout: 20000, windowsHide: true },
      );
      writeFileSync(
        resolve(dir, `${mode}.json`),
        JSON.stringify({
          status: child.status,
          signal: child.signal,
          stdout: child.stdout,
          stderr: child.stderr,
          error: child.error?.message,
        }),
      );
      assert.equal(child.error, undefined);
      if (mode === "crash") {
        assert.notEqual(child.status, 0);
        assert.match(child.stdout, /PLANNING_CLOSE_SAVED/);
      } else assert.equal(child.status, 0, child.stderr);
    }
    const recovered = new Store(db);
    try {
      const calls = recovered.modelCalls(id!);
      assert.deepEqual(
        calls.map((c) => c.scope),
        [
          "plan:0",
          "plan:1",
          "plan:2",
          "plan:3",
          "plan:4",
          "expert:profile:turn:0",
          "expert:profile:turn:1",
          "expert:profile:turn:2",
          "synthesize",
        ],
      );
      assert.deepEqual(calls[4]!.toolNames, ["plan_submit"]);
      assert.equal(
        (calls[4]!.executionState as any).planning
          .consecutiveTurnsWithoutNewHistory,
        3,
      );
      assert.equal(recovered.run(id!).status, "partial");
      assert(recovered.events(id!).some((e) => e.type === "model.recovered"));
    } finally {
      recovered.close();
    }
  });
  for (const mode of ["repeated-pages", "last-turn"] as const) {
    test(`${architecture}: planner ${mode} reserves a real plan submission without granting expert history`, async () => {
      const store = new Store(":memory:");
      try {
        const cfg = {
          ...config(),
          maxPlanningTurns: mode === "last-turn" ? 3 : 16,
          maxCalls: 80,
          maxInputTokens: 8000000,
          maxContextTokens: 96000,
          activeContextTarget: 18000,
        };
        const setup = new Runtime(
          store,
          knowledge,
          new ReplayProvider([]),
          cfg,
        );
        const root = setup.create({
          userId: "u",
          conversationId: "c",
          architecture,
          request: "占位符".repeat(10000),
        });
        store.update(root.id, { status: "partial" });
        const run = setup.reply(root.id, "u", {
          operationId: "reply",
          reply: "核对之前的材料，没有具体经历则提出追问",
        });
        const sourceId = `input:${run.id}:turn:0:request`;
        const read = (offset: number, maxChars = 8000) =>
          call("input_history_read", { sourceId, offset, maxChars });
        const sequence =
          mode === "last-turn"
            ? [call("input_history_list", {}), read(0), plan(), ...finish()]
            : [
                call("input_history_list", {}),
                read(0),
                read(8000),
                read(16000),
                read(24000),
                read(0),
                read(0, 4000),
                read(100, 3000),
                read(0),
                plan(),
                ...finish(),
              ];
        const runtime = new Runtime(
          store,
          knowledge,
          new ReplayProvider(sequence),
          cfg,
        );
        const result = await runtime.execute(run.id, "u");
        assert.equal(result.status, "partial", result.error);
        assert.equal(store.artifacts(run.id)[0]?.result.status, "needs_input");
        const calls = store.modelCalls(run.id),
          plans = calls.filter((c) => String(c.scope).startsWith("plan:"));
        const closing = plans[mode === "last-turn" ? 2 : 8]!;
        assert.deepEqual(closing.toolNames, ["plan_submit"]);
        const state = closing.executionState as any;
        assert.equal(state.schemaVersion, "planning-state-v2");
        assert.equal(
          state.planning.reason,
          mode === "last-turn" ? "last_planning_turn" : "no_new_history",
        );
        assert.equal(
          state.planning.remainingTurnsIncludingCurrent,
          mode === "last-turn" ? 1 : 8,
        );
        assert.equal(
          (
            calls.find((c) => c.scope === "expert:profile:turn:0")!
              .executionState as any
          ).inputHistory.totalReadPages,
          0,
        );
        if (mode === "repeated-pages") {
          assert(
            store.events(run.id).filter((e) => e.type === "context.compacted")
              .length >= 3,
          );
          assert.equal(
            store
              .events(run.id)
              .filter(
                (e) =>
                  e.type === "tool.started" &&
                  e.expert === "orchestrator" &&
                  (e.payload as { name?: string }).name ===
                    "input_history_read",
              ).length,
            7,
            "offered plan-only scope must reject a hallucinated read without execution",
          );
          assert(
            JSON.stringify(plans[9]!.messages).includes(
              "Submit plan_submit alone now",
            ),
          );
          assert(
            plans
              .slice(0, 8)
              .every((c) =>
                (c.toolNames as string[]).includes("input_history_read"),
              ),
          );
        }
      } finally {
        store.close();
      }
    });
  }
}
