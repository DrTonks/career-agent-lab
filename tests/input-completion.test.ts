import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { Store } from "../src/storage.js";
import { Runtime } from "../src/runtime.js";
import { DomainTools, DomainValidationError } from "../src/tools.js";
import { Knowledge } from "../src/retrieval.js";
import { loadDataset } from "../src/data.js";
import { ROOT } from "../src/config.js";
import { ReplayProvider } from "../src/providers.js";
import type { ModelReply } from "../src/contracts.js";
import { config } from "./test-config.js";
const knowledge = new Knowledge(
  loadDataset(resolve(ROOT, "data/synthetic/dataset.json")),
);
const request = {
  userId: "completion",
  conversationId: "c",
  request: "甲".repeat(200) + "乙".repeat(200) + "丙".repeat(200),
};

test("end of a page sequence differs from complete cumulative coverage; end reads cannot grant empty evidence", async () => {
  const store = new Store(":memory:");
  try {
    const runtime = new Runtime(
        store,
        knowledge,
        new ReplayProvider([]),
        config(),
      ),
      run = runtime.create(request);
    const make = (id = "p") =>
      new DomainTools(
        "profile",
        run,
        id,
        store,
        knowledge,
        [],
        new AbortController().signal,
      );
    const tools = make();
    assert.deepEqual(tools.executionState().inputCoverage.resume, {
      complete: false,
      nextOffset: 0,
      totalChars: 0,
    });
    await tools.invoke(
      "input_read",
      { source: "request", offset: 0, maxChars: 200 },
      "first",
    );
    const tail = (await tools.invoke(
      "input_read",
      { source: "request", offset: 400, maxChars: 200 },
      "last",
    )) as any;
    assert.equal(tail.nextOffset, null);
    assert.equal(tail.pageEndReached, true);
    assert.equal(tail.containsWholeSource, false);
    assert.equal("complete" in tail, false);
    assert.deepEqual(tools.executionState().inputCoverage.request, {
      complete: false,
      nextOffset: 200,
      totalChars: 600,
    });
    await assert.rejects(
      tools.invoke(
        "input_read",
        { source: "request", offset: 600, maxChars: 200 },
        "end-gap",
      ),
      (error: unknown) => {
        assert(error instanceof DomainValidationError);
        assert.equal(error.feedback.code, "input_read_at_end");
        assert.deepEqual(error.feedback.coverage, {
          complete: false,
          nextOffset: 200,
          totalChars: 600,
        });
        return true;
      },
    );
    await tools.invoke(
      "input_read",
      { source: "request", offset: 200, maxChars: 200 },
      "middle",
    );
    assert.deepEqual(make().executionState().inputCoverage.request, {
      complete: true,
      nextOffset: null,
      totalChars: 600,
    });
    await assert.rejects(
      make("new-attempt").invoke(
        "input_read",
        { source: "request", offset: 600 },
        "unread-end",
      ),
      DomainValidationError,
    );
    const unread = make("new-attempt");
    assert.equal(unread.seen.size, 0);
    assert.equal(unread.executionState().inputCoverage.request.complete, false);
    await tools.invoke("input_read", { source: "resume", offset: 0 }, "empty");
    assert.deepEqual(make().executionState().inputCoverage.resume, {
      complete: true,
      nextOffset: null,
      totalChars: 0,
    });
    await assert.rejects(
      tools.invoke(
        "input_read",
        { source: "resume", offset: 1 },
        "empty-beyond",
      ),
      DomainValidationError,
    );
    assert.equal(
      store.cacheEntries(run.id, "clarification:p:profile:read:").length,
      4,
    );
  } finally {
    store.close();
  }
});

const tool = (name: string, args: unknown): { reply: ModelReply } => ({
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
for (const architecture of ["multi-agent", "skills"] as const) {
  test(`${architecture}: actual next model request gets null on completion and gap feedback without extra evidence`, async () => {
    const store = new Store(":memory:");
    try {
      const runtime = new Runtime(
        store,
        knowledge,
        new ReplayProvider([
          tool("plan_submit", {
            rationale: "核验输入",
            steps: [
              {
                id: "profile",
                expert: "profile",
                objective: "核验材料",
                dependsOn: [],
              },
            ],
          }),
          tool("input_read", { source: "request", offset: 0, maxChars: 200 }),
          tool("input_read", { source: "request", offset: 400, maxChars: 200 }),
          tool("input_read", { source: "request", offset: 600, maxChars: 200 }),
          tool("input_read", { source: "request", offset: 200, maxChars: 200 }),
          tool("input_read", { source: "resume", offset: 0 }),
          tool("expert_finish", {
            status: "needs_input",
            summary: "输入仅为占位文本，需真实经历",
            evidenceIds: [],
            unknowns: ["具体经历"],
            conflicts: [],
            nextActions: [],
            artifact: {},
          }),
          {
            reply: {
              message: { role: "assistant", content: "请补充具体经历" },
              usage: { input: 10, output: 10, cachedInput: 0 },
              finishReason: "stop",
            },
          },
        ]),
        config(),
      );
      const run = runtime.create({ ...request, architecture });
      assert.equal(
        (await runtime.execute(run.id, request.userId)).status,
        "partial",
      );
      const calls = store.modelCalls(run.id);
      const afterGap = calls.find((c) => c.scope === "expert:profile:turn:3")!;
      assert.deepEqual((afterGap.executionState as any).inputCoverage.request, {
        complete: false,
        nextOffset: 200,
        totalChars: 600,
      });
      assert(JSON.stringify(afterGap.messages).includes("input_read_at_end"));
      const final = calls.find((c) => c.scope === "expert:profile:turn:5")!;
      assert.equal(
        (final.executionState as any).schemaVersion,
        "execution-state-v2",
      );
      assert.deepEqual((final.executionState as any).inputCoverage.request, {
        complete: true,
        nextOffset: null,
        totalChars: 600,
      });
      assert.deepEqual((final.executionState as any).inputCoverage.resume, {
        complete: true,
        nextOffset: null,
        totalChars: 0,
      });
      assert.equal(
        store.events(run.id).filter((e) => e.type === "tool.failed").length,
        1,
      );
      assert.equal(store.modelCalls(run.id).length, 8);
    } finally {
      store.close();
    }
  });
}
