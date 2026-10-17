import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { Store } from "../src/storage.js";
import { Runtime } from "../src/runtime.js";
import { CompatibleProvider, ReplayProvider } from "../src/providers.js";
import { Knowledge } from "../src/retrieval.js";
import { loadDataset } from "../src/data.js";
import { ROOT } from "../src/config.js";
import { config } from "./test-config.js";
import { Request, type ModelReply } from "../src/contracts.js";
import { runMetrics } from "../src/evaluation.js";

const data = loadDataset(resolve(ROOT, "data/synthetic/dataset.json"));
const request = Request.parse({
  userId: "stream-test",
  conversationId: "test",
  request: "验证流式记录",
});
for (const malformed of [false, true]) {
  test(`runtime preserves partial stream evidence and actual usage, malformed=${malformed}`, async (t) => {
    const frame = {
      choices: [
        {
          delta: {
            content: "已收到但未完成",
            reasoning_content: "DO_NOT_RECORD_HIDDEN_REASONING",
            tool_calls: [
              {
                index: 0,
                id: "partial",
                function: { name: "plan_submit", arguments: '{"rationale":' },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 20, completion_tokens: 5 },
    };
    t.mock.method(
      globalThis,
      "fetch",
      async () =>
        new Response(
          `data: ${JSON.stringify(frame)}\n${malformed ? "data: {bad}\n" : ""}`,
        ),
    );
    const s = new Store(":memory:");
    try {
      const cfg = {
        ...config(),
        model: "protocol-test",
        baseUrl: "https://api.example.com",
      };
      const rt = new Runtime(
        s,
        new Knowledge(data),
        new CompatibleProvider(cfg, "not-a-real-key"),
        cfg,
      );
      const r = rt.create(request),
        done = await rt.execute(r.id, request.userId);
      assert.equal(done.status, "failed");
      const calls = s.modelCalls(r.id);
      assert.equal(calls.length, malformed ? 1 : 2);
      for (const call of calls) {
        assert.equal(call.status, "failed");
        assert.equal(call.response, undefined);
        assert.equal((call.partialResponse as any).content, "已收到但未完成");
        assert.equal(
          (call.partialResponse as any).tool_calls[0].function.arguments,
          '{"rationale":',
        );
        assert.equal(call.streamFrames, 1);
        assert.equal((call.usage as any).input, 20);
      }
      assert.equal(runMetrics(s, r.id).inputTokens, malformed ? 20 : 40);
      assert.equal(s.artifacts(r.id).length, 0);
      assert.equal(
        s.events(r.id).filter((e) => e.type === "model.stream").length,
        calls.length,
      );
      assert(
        !JSON.stringify([calls, s.events(r.id)]).includes(
          "DO_NOT_RECORD_HIDDEN_REASONING",
        ),
      );
    } finally {
      s.close();
    }
  });
}
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
for (const corrupt of [false, true]) {
  test(`takeover audits an abandoned scope even when the new plan never schedules it; corrupt=${corrupt}`, async () => {
    const s = new Store(":memory:");
    try {
      const rt = new Runtime(
        s,
        new Knowledge(data),
        new ReplayProvider([
          call("plan_submit", {
            rationale: "当前任务",
            steps: [
              {
                id: "profile",
                expert: "profile",
                objective: "当前画像",
                dependsOn: [],
              },
            ],
          }),
          call("expert_finish", {
            status: "needs_input",
            summary: "等待输入",
            evidenceIds: [],
            unknowns: [],
            conflicts: [],
            nextActions: [],
            artifact: {},
          }),
          {
            reply: {
              message: { role: "assistant", content: "请补充输入。" },
              usage: { input: 10, output: 10, cachedInput: 0 },
              finishReason: "stop",
            },
          },
        ]),
        config(),
      );
      const r = rt.create(request);
      s.modelCall("abandoned", r.id, {
        id: "abandoned",
        role: "report",
        scope: "obsolete-step",
        requestKey: "never-replayed",
        status: "started",
        inputEstimate: 10,
        outputReserved: 10,
      });
      s.event(
        r.id,
        "model.stream",
        { frame: { sequence: 1, contentDelta: "保留的旧片段" } },
        "report",
        "abandoned",
      );
      if (corrupt)
        s.event(
          r.id,
          "model.stream",
          { frame: { sequence: 3, contentDelta: "缺序片段" } },
          "report",
          "abandoned",
        );
      const done = await rt.execute(r.id, request.userId);
      assert.equal(done.status, "partial", done.error);
      const old = s.modelCalls(r.id).find((c) => c.id === "abandoned")!;
      assert.equal(old.status, "interrupted");
      assert.equal((old.partialResponse as any).content, "保留的旧片段");
      assert.equal(!!old.reconstructionError, corrupt);
      assert.equal(
        s
          .events(r.id)
          .filter(
            (e) => e.type === "model.interrupted" && e.callId === "abandoned",
          ).length,
        1,
      );
      assert.equal(
        s.events(r.id).filter((e) => e.type === "model.stream").length,
        corrupt ? 2 : 1,
      );
      assert.equal(s.modelCalls(r.id).length, 4);
      assert.equal(s.artifacts(r.id).length, 1);
    } finally {
      s.close();
    }
  });
}
test(
  "cancelling during a delayed retrieval prevents late tool cache and artifacts",
  { timeout: 10000 },
  async () => {
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((r) => {
        entered = r;
      }),
      delayed = new Promise<void>((r) => {
        release = r;
      });
    const k = new Knowledge(data, {
      mode: "deliberately-delayed-test",
      fingerprint: "cancel-fixture",
      async rank() {
        entered();
        await delayed;
        return [];
      },
    });
    const s = new Store(":memory:");
    try {
      const rt = new Runtime(
        s,
        k,
        new ReplayProvider([
          call("plan_submit", {
            rationale: "查询知识",
            steps: [
              {
                id: "match",
                expert: "match",
                objective: "查询规则",
                dependsOn: [],
              },
            ],
          }),
          call("knowledge_search", { query: "岗位" }),
        ]),
        config(),
      );
      const r = rt.create(request),
        execution = rt.execute(r.id, request.userId);
      await started;
      const before = Number(
        s.db
          .prepare("SELECT count(*) AS n FROM tool_cache WHERE run_id=?")
          .get(r.id)!.n,
      );
      s.cancel(r.id, request.userId);
      release();
      const done = await execution;
      assert.equal(done.status, "cancelled");
      assert.equal(
        Number(
          s.db
            .prepare("SELECT count(*) AS n FROM tool_cache WHERE run_id=?")
            .get(r.id)!.n,
        ),
        before,
      );
      assert.equal(s.artifacts(r.id).length, 0);
      assert.equal(s.proposals(r.id).length, 0);
      assert(
        !s
          .events(r.id)
          .some(
            (e) =>
              e.type === "tool.completed" &&
              (e.payload as any).name === "knowledge_search",
          ),
      );
      assert(
        s
          .events(r.id)
          .some(
            (e) =>
              e.type === "tool.failed" &&
              (e.payload as any).name === "knowledge_search",
          ),
      );
      assert.equal(s.modelCalls(r.id).length, 2);
    } finally {
      release();
      s.close();
    }
  },
);
