import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { config, ROOT, estimateTokens } from "../src/config.js";
import { phaseCapacity, dependencyReadGroups } from "../src/capacity.js";
import { compactMessages, Runtime } from "../src/runtime.js";
import { Store } from "../src/storage.js";
import { Knowledge } from "../src/retrieval.js";
import { loadDataset } from "../src/data.js";
import { Request, type Message } from "../src/contracts.js";
import { reviewProvider } from "./fixtures/final-review-provider.js";
test("phase reservation stays inside run ceilings and releases only for final stages", () => {
  const cfg = {
    ...config(),
    finalReview: "model" as const,
    maxCalls: 40,
    maxInputTokens: 300000,
    maxOutputTokens: 40000,
    finalReserveCalls: 4,
    finalReserveInputTokens: 40000,
    finalReserveOutputTokens: 12000,
  };
  const p = phaseCapacity(cfg, "expert:report:turn:0");
  assert.equal(p.calls, 36);
  assert.equal(p.input, 260000);
  assert.equal(p.output, 28000);
  for (const scope of ["synthesize", "final-review:0", "final-repair:1"]) {
    const f = phaseCapacity(cfg, scope);
    assert.equal(f.input, 300000);
    assert.equal(f.calls, 40);
    assert.equal(f.output, 40000);
  }
  assert.equal(
    phaseCapacity({ ...cfg, finalReview: "off" }, "expert:profile:turn:0")
      .input,
    300000,
  );
  const small = phaseCapacity(
    { ...cfg, maxCalls: 3, maxInputTokens: 1000, maxOutputTokens: 1000 },
    "plan:0",
  );
  assert(small.calls >= 2);
  assert(small.input > 0 && small.input < 1000);
  assert(small.output > 0 && small.output < 1000);
});

test("explicit final reservation supports two review passes inside the total and records clamps for small runs", () => {
  const cfg = {
    ...config(),
    finalReview: "model" as const,
    maxCalls: 60,
    maxInputTokens: 600000,
    maxOutputTokens: 80000,
    finalReserveCalls: 24,
    finalReserveInputTokens: 240000,
    finalReserveOutputTokens: 32768,
  };
  const execution = phaseCapacity(cfg, "expert:report:turn:0");
  assert.deepEqual(execution.reserved, {
    calls: 24,
    input: 240000,
    output: 32768,
  });
  assert.equal(execution.calls, 36);
  assert.equal(execution.input, 360000);
  assert.equal(execution.output, 47232);
  const small = phaseCapacity(
    { ...cfg, maxCalls: 7, maxInputTokens: 1000, maxOutputTokens: 1000 },
    "plan:0",
  );
  assert.deepEqual(small.reserved, { calls: 5, input: 600, output: 600 });
  assert.deepEqual(small.requestedReservation, {
    calls: 24,
    input: 240000,
    output: 32768,
  });
  const disabled = phaseCapacity(
    {
      ...cfg,
      finalReserveCalls: 0,
      finalReserveInputTokens: 0,
      finalReserveOutputTokens: 0,
    },
    "plan:0",
  );
  assert.deepEqual(disabled.reserved, { calls: 0, input: 0, output: 0 });
});

test("reservation configuration rejects negative and fractional allowances, but permits explicit zero", () => {
  const key = "CAREER_FINAL_RESERVE_CALLS",
    previous = process.env[key];
  try {
    for (const value of ["-1", "1.5", "NaN"]) {
      process.env[key] = value;
      assert.throws(() => config(), /CAREER_FINAL_RESERVE_CALLS/);
    }
    process.env[key] = "0";
    assert.equal(config().finalReserveCalls, 0);
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
});
test("bounded history retains current task and complete newest tool result without leaking omitted middle text", () => {
  const m: Message[] = [
    { role: "system", content: "ROLE: profile" },
    { role: "user", content: "TASK_DATA current goal" },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "old",
          type: "function",
          function: { name: "input_read", arguments: "{}" },
        },
      ],
    },
    {
      role: "tool",
      tool_call_id: "old",
      content: JSON.stringify({
        evidence: {
          id: "input:r:resume",
          text: "a".repeat(700) + "OLD_DETAIL_NOT_IN_DIGEST" + "b".repeat(9000),
        },
      }),
    },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "new",
          type: "function",
          function: { name: "memory_recall", arguments: "{}" },
        },
      ],
    },
    { role: "tool", tool_call_id: "new", content: '{"memories":[]}' },
  ];
  const packed = compactMessages(m, 1000);
  assert(packed.removed >= 2);
  assert(estimateTokens(JSON.stringify(packed.messages)) < 1100);
  assert(packed.messages.some((x) => x.content === "TASK_DATA current goal"));
  assert(packed.messages.some((x) => x.tool_call_id === "new"));
  assert(packed.messages.some((x) => x.tool_calls?.[0]?.id === "new"));
  assert(!JSON.stringify(packed.messages).includes("OLD_DETAIL_NOT_IN_DIGEST"));
});
test("soft context target may yield to mandatory input but never bypasses global capacity", async () => {
  const s = new Store(":memory:");
  try {
    const cfg = {
      ...config(),
      finalReview: "off" as const,
      activeContextTarget: 500,
    };
    const rt = new Runtime(
      s,
      new Knowledge(loadDataset(resolve(ROOT, "data/synthetic/dataset.json"))),
      reviewProvider(),
      cfg,
    );
    const r = rt.create(
      Request.parse({
        userId: "capacity",
        conversationId: "c",
        request: "画像",
      }),
    );
    await rt.execute(r.id, "capacity");
    assert(s.events(r.id).some((e) => e.type === "context.target_exceeded"));
    for (const c of s.modelCalls(r.id)) {
      assert(Number(c.inputEstimate) <= cfg.maxInputTokens);
      assert(Array.isArray(c.toolDefinitions));
      assert.deepEqual(
        (c.toolDefinitions as any[]).map((t) => t.function.name),
        c.toolNames,
      );
      assert.equal(c.outputLimit, cfg.maxResponseTokens);
    }
    const cfg2 = { ...cfg, maxContextTokens: 100 };
    const next = new Runtime(
      s,
      new Knowledge(loadDataset(resolve(ROOT, "data/synthetic/dataset.json"))),
      reviewProvider(),
      cfg2,
    );
    const r2 = next.create(
      Request.parse({
        userId: "capacity-small",
        conversationId: "c",
        request: "画像",
      }),
    );
    assert.equal(
      (await next.execute(r2.id, "capacity-small")).status,
      "failed",
    );
    assert.equal(s.modelCalls(r2.id).length, 0);
  } finally {
    s.close();
  }
});

test("compaction retains current dependency working set as whole groups and lets hard capacity reject oversize sets", () => {
  const messages: Message[] = [
    { role: "system", content: "policy" },
    { role: "user", content: "TASK_DATA current inputs" },
  ];
  for (const name of ["stale", "a", "b", "c"]) {
    messages.push({
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: name,
          type: "function",
          function: {
            name: "artifact_read",
            arguments: JSON.stringify({ id: name }),
          },
        },
      ],
    });
    messages.push({
      role: "tool",
      tool_call_id: name,
      content: JSON.stringify({
        evidence: {
          id: `artifact:${name}`,
          version: "1",
          kind: "artifact",
          text: JSON.stringify({
            artifact: { details: name.repeat(1800), marker: `END_${name}` },
          }),
        },
      }),
    });
  }
  messages.push(
    { role: "assistant", content: "ready" },
    { role: "user", content: "Finish the current step" },
  );
  const keep = ["a", "b", "c"].map((n) => `artifact:${n}@1`);
  const packed = compactMessages(messages, 5000, keep);
  for (const id of ["a", "b", "c"]) {
    assert(packed.messages.some((m) => m.tool_calls?.some((t) => t.id === id)));
    assert(
      packed.messages.some(
        (m) => m.tool_call_id === id && m.content?.includes(`END_${id}`),
      ),
    );
  }
  assert(!packed.messages.some((m) => m.tool_call_id === "stale"));
  assert.throws(() => compactMessages(messages, 500, keep), /Required context/);
  const outdated = compactMessages(messages, 1800, ["artifact:a@2"]);
  assert(!outdated.messages.some((m) => m.tool_call_id === "a"));
});

test("dependency pagination retains disjoint and partially overlapping pages, but newer complete coverage replaces redundant reads", () => {
  const messages: Message[] = [
    { role: "system", content: "policy" },
    { role: "user", content: "TASK_DATA" },
  ];
  const add = (id: string, offset: number, text: string, version = "1") => {
    messages.push({
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id,
          type: "function",
          function: {
            name: "artifact_read",
            arguments: JSON.stringify({ id: "a", offset }),
          },
        },
      ],
    });
    messages.push({
      role: "tool",
      tool_call_id: id,
      content: JSON.stringify({
        evidence: { id: "artifact:a", version, kind: "artifact", text },
        offset,
        totalChars: 6000,
      }),
    });
  };
  add("old-version", 0, "o".repeat(3000), "0");
  add("first", 0, "a".repeat(2000));
  add("duplicate-first", 0, "a".repeat(2000));
  add("middle", 1800, "a".repeat(200) + "b".repeat(1800));
  add("last", 4000, "c".repeat(2000));
  const ids = () =>
    [...dependencyReadGroups(messages, ["artifact:a@1"])]
      .flatMap((m) => m.tool_calls!.map((t) => t.id))
      .sort();
  assert.deepEqual(ids(), ["duplicate-first", "last", "middle"]);
  messages.push({ role: "user", content: "Finish" });
  const packed = compactMessages(messages, 5000, ["artifact:a@1"]);
  for (const id of ["duplicate-first", "middle", "last"])
    assert(packed.messages.some((m) => m.tool_call_id === id));
  assert(!packed.messages.some((m) => m.tool_call_id === "old-version"));
  assert.throws(
    () => compactMessages(messages, 500, ["artifact:a@1"]),
    /Required context/,
  );
  add("full", 0, "a".repeat(2000) + "b".repeat(2000) + "c".repeat(2000));
  assert.deepEqual(ids(), ["full"]);
  assert.equal(dependencyReadGroups(messages, ["artifact:a@2"]).size, 0);
});
