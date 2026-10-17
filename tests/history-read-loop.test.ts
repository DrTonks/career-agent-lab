import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { historyReadLoop } from "../src/history-read-loop.js";
import { hash, ROOT } from "../src/config.js";
import { HistoryRead } from "../src/input-history-tools.js";
import { Store } from "../src/storage.js";
import { Runtime } from "../src/runtime.js";
import { ReplayProvider } from "../src/providers.js";
import { Knowledge } from "../src/retrieval.js";
import { loadDataset } from "../src/data.js";
import type { ModelReply } from "../src/contracts.js";
import { config } from "./test-config.js";

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
    rationale: "核对材料",
    steps: [
      {
        id: "profile",
        expert: "profile",
        objective: "核对材料并追问",
        dependsOn: [],
      },
    ],
  });
const finish = () => [
  call("input_read", { source: "request" }),
  call("input_read", { source: "resume" }),
  call("expert_finish", {
    status: "needs_input",
    summary: "需要具体经历",
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
function setup(
  store: Store,
  architecture: "multi-agent" | "skills",
  cfg = config(),
) {
  const rt = new Runtime(store, knowledge, new ReplayProvider([]), cfg);
  const parent = rt.create({
    userId: "u",
    conversationId: "c",
    request: "待补充",
    architecture,
  });
  store.update(parent.id, { status: "partial" });
  return rt.reply(parent.id, "u", {
    operationId: "next",
    reply: "核对原材料并追问",
  });
}

test("read-loop control uses successful normalized batches, ignores future recovery responses and keeps attempt/role isolation", () => {
  const cache = new Map<string, unknown>();
  const record = (
    turn: number,
    execution = "profile",
    args = { sourceId: "s" },
  ) => {
    const parsed = HistoryRead.parse(args);
    cache.set(hash([execution, "profile", "input_history_read", parsed]), {
      sourceId: "s",
      offset: 0,
      end: 3,
      evidence: { text: "abc" },
    });
    return {
      scope: `expert:${execution}:turn:${turn}`,
      status: "completed",
      response: call("input_history_read", args).reply.message,
    };
  };
  const calls = Array.from({ length: 6 }, (_, i) => record(i));
  const state = (turn: number, execution = "profile", role = "profile") =>
    historyReadLoop(calls, execution, role, turn, (k) => cache.get(k));
  assert.equal(state(3).phase, "change_action");
  assert.equal(state(3).consecutiveIdenticalBatches, 3);
  assert.equal(state(5).phase, "stopped");
  assert.equal(state(3, "profile@2").phase, "normal");
  assert.equal(state(3, "profile", "report").phase, "normal");
  cache.clear();
  assert.equal(
    state(5).consecutiveIdenticalBatches,
    0,
    "a response alone is not a successful read",
  );
});

test("new pages, intervening actions, missing turns and failed calls break an identical read sequence", () => {
  const records = Array.from({ length: 5 }, (_, turn) => ({
    scope: `expert:profile:turn:${turn}`,
    status: "completed",
    response: call("input_history_read", { sourceId: "s", offset: turn * 10 })
      .reply.message,
  }));
  const cache = new Map<string, unknown>();
  for (let i = 0; i < 5; i++)
    cache.set(
      hash([
        "profile",
        "profile",
        "input_history_read",
        HistoryRead.parse({ sourceId: "s", offset: i * 10 }),
      ]),
      { sourceId: "s", offset: i * 10, evidence: { text: String(i) } },
    );
  const get = () =>
    historyReadLoop(records, "profile", "profile", 5, (k) => cache.get(k));
  assert.equal(get().consecutiveIdenticalBatches, 1);
  records[4]!.response = call("profile_score", {}).reply.message;
  assert.equal(get().consecutiveIdenticalBatches, 0);
  records.pop();
  assert.equal(get().consecutiveIdenticalBatches, 0);
  records.push({
    scope: "expert:profile:turn:4",
    status: "failed",
    response: call("input_history_read", { sourceId: "s" }).reply.message,
  });
  assert.equal(get().consecutiveIdenticalBatches, 0);
});

for (const architecture of ["multi-agent", "skills"] as const) {
  for (const repair of [true, false])
    test(`${architecture}: history loop ${repair ? "can act on feedback and finish" : "ends explicitly without automatic whole-expert retries"}`, async () => {
      const store = new Store(":memory:");
      try {
        const run = setup(store, architecture);
        const reads = Array.from({ length: repair ? 3 : 5 }, () =>
          call("input_history_read", {
            sourceId: `input:${run.id}:turn:0:request`,
          }),
        );
        const provider = new ReplayProvider([plan(), ...reads, ...finish()]);
        const rt = new Runtime(store, knowledge, provider, config());
        const done = await rt.execute(run.id, "u");
        const calls = store
          .modelCalls(run.id)
          .filter((c) => String(c.scope).startsWith("expert:"));
        assert.equal(
          (calls[3]!.executionState as any).historyReadLoop.phase,
          "change_action",
        );
        const artifact = store.artifacts(run.id)[0]!;
        if (repair) {
          assert.equal(done.status, "partial");
          assert.equal(artifact.result.status, "needs_input");
        } else {
          assert.equal(done.status, "failed");
          assert.equal(calls.length, 5);
          assert.equal(artifact.failure?.code, "expert_no_progress");
          assert.equal(artifact.failure?.retryable, false);
          assert.equal(store.artifactHistory(run.id).length, 1);
        }
      } finally {
        store.close();
      }
    });

  test(`${architecture}: progress feedback survives actual process termination after its model response`, () => {
    mkdirSync(resolve(ROOT, "var/tests"), { recursive: true });
    const dir = mkdtempSync(resolve(ROOT, "var/tests/history-loop-")),
      db = resolve(dir, "runs.sqlite"),
      fixture = resolve(dir, "replay.json");
    const store = new Store(db);
    let id: string;
    try {
      id = setup(store, architecture, { ...config(), leaseTtlMs: 1000 }).id;
      writeFileSync(
        fixture,
        JSON.stringify([
          plan(),
          ...Array.from({ length: 3 }, () =>
            call("input_history_read", {
              sourceId: `input:${id}:turn:0:request`,
            }),
          ),
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
          resolve(ROOT, "dist/tests/fixtures/history-loop-worker.js"),
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
        assert.match(child.stdout, /HISTORY_LOOP_FEEDBACK_SAVED/);
      } else assert.equal(child.status, 0, child.stderr);
    }
    const recovered = new Store(db);
    try {
      const calls = recovered.modelCalls(id!);
      assert.equal(calls.length, 8);
      assert.equal(new Set(calls.map((c) => c.scope)).size, calls.length);
      assert.equal(
        (calls[4]!.executionState as any).historyReadLoop.phase,
        "change_action",
      );
      assert(recovered.events(id!).some((e) => e.type === "model.recovered"));
    } finally {
      recovered.close();
    }
  });
}
