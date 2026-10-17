import test from "node:test";
import assert from "node:assert/strict";
import { compactMessages } from "../src/runtime.js";
import {
  WORKING_SET_PREFIX,
  WorkingSet,
  workReceipt,
} from "../src/working-set.js";
import { estimateTokens, hash } from "../src/config.js";
import type { Message } from "../src/contracts.js";
function pair(
  name: string,
  args: unknown,
  result: unknown,
  id = name,
): Message[] {
  return [
    {
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
    { role: "tool", tool_call_id: id, content: JSON.stringify(result) },
  ];
}
const pathResult = {
  mode: "transfer",
  paths: [
    {
      nodes: ["front", "qa"],
      cost: 0.2,
      evidence: [
        {
          id: "edge:transfer:front:qa",
          text: "large primary text ".repeat(800),
        },
      ],
    },
  ],
};
const readWork = (messages: Message[]) => {
  const m = messages.find((m) => m.content?.startsWith(WORKING_SET_PREFIX));
  return m
    ? JSON.parse(m.content!.slice(WORKING_SET_PREFIX.length))
    : undefined;
};
test("compaction retains completed graph work and exact replay arguments across another compaction", () => {
  const messages: Message[] = [
    { role: "system", content: "path" },
    { role: "user", content: "TASK_DATA transfer" },
    ...pair(
      "graph_paths",
      { start: "front", target: "qa", maxDepth: 4 },
      pathResult,
    ),
    ...pair(
      "jobs_check",
      { jobIds: ["j"], observedSkills: ["Vue"] },
      {
        results: [
          {
            id: "j",
            eligible: false,
            unknowns: ["weekendsOff"],
            violations: [],
            checks: { weekendsOff: "unknown" },
          },
        ],
      },
    ),
  ];
  const first = compactMessages(messages, 2200);
  assert(first.removed >= 2);
  const receipt = readWork(first.messages).entries.find(
    (e: any) => e.tool === "graph_paths",
  );
  assert.deepEqual(receipt.summary.paths.items[0].nodes, ["front", "qa"]);
  assert.deepEqual(receipt.summary.paths.items[0].edgeEvidenceIds, [
    "edge:transfer:front:qa",
  ]);
  assert.equal(receipt.resultHash, hash(pathResult));
  assert.deepEqual(receipt.arguments, {
    start: "front",
    target: "qa",
    maxDepth: 4,
  });
  assert(!JSON.stringify(first.messages).includes("large primary text"));
  const second = compactMessages(
    [
      ...first.messages,
      { role: "assistant", content: "discard ".repeat(2000) },
      ...pair(
        "jobs_search",
        {},
        {
          eligible: [],
          uncertain: [],
          counts: { beforeFilter: 24, eligible: 0, unknown: 0 },
        },
      ),
    ],
    2200,
  );
  assert(
    readWork(second.messages).entries.some(
      (e: any) => e.tool === "graph_paths",
    ),
  );
  assert(estimateTokens(JSON.stringify(second.messages)) <= 2200);
});
test("new task activation discards old task working receipts", () => {
  const w = new WorkingSet(hash("TASK_DATA old"));
  w.add(
    workReceipt(
      pair("graph_paths", {}, pathResult)[0]!.tool_calls![0]!,
      pathResult,
    )!,
  );
  const messages: Message[] = [
    { role: "system", content: "skills" },
    { role: "user", content: "TASK_DATA old" },
    w.message(4000)!,
    { role: "user", content: "TASK_DATA new constraints" },
    ...pair("memory_recall", {}, { memories: [] }),
  ];
  const packed = compactMessages(messages, 2000);
  assert.equal(readWork(packed.messages), undefined);
  assert(!JSON.stringify(packed.messages).includes("edge:transfer:front:qa"));
});
test("search summaries distinguish zero matches, uncertain candidates and omitted category coverage", () => {
  const value = {
    eligible: [],
    uncertain: [
      { jobId: "j", evidence: { id: "job:j" }, unknowns: ["weekendsOff"] },
    ],
    counts: { beforeFilter: 100, eligible: 0, unknown: 1 },
    categoryCoverage: Array.from({ length: 12 }, (_, i) => ({
      categoryId: `c${i}`,
      eligible: 0,
    })),
    constraintVersion: 3,
    dataScope: { recruitmentStatus: "not_applicable" },
  };
  const r = workReceipt(
    pair("jobs_search", { query: "q" }, value)[0]!.tool_calls![0]!,
    value,
  )!;
  assert.deepEqual(r.summary.counts, value.counts);
  assert.equal((r.summary.eligible as any).returnedCount, 0);
  assert.equal(
    (r.summary.uncertain as any).items[0].unknowns[0],
    "weekendsOff",
  );
  assert.equal((r.summary.categoryCoverage as any).omittedCount, 2);
  assert.equal(r.summary.constraintVersion, 3);
});
test("bounded working sets retain whole JSON records and explicitly count omitted results", () => {
  const w = new WorkingSet("task");
  for (let i = 0; i < 30; i++) {
    const result = {
      paths: [{ nodes: [`n${i}`, `n${i + 1}`], cost: i, evidence: [] }],
    };
    w.add(
      workReceipt(
        pair("graph_paths", { start: `n${i}` }, result)[0]!.tool_calls![0]!,
        result,
      )!,
    );
  }
  const m = w.message(1800)!;
  assert(estimateTokens(JSON.stringify(m)) <= 1800);
  const data = readWork([m]);
  assert(data.omittedReceiptCount > 0);
  assert.equal(data.omittedReceiptCount + data.entries.length, 30);
  const restored = new WorkingSet("task");
  restored.restore(m.content!);
  const next = readWork([restored.message(1800)!]);
  assert.equal(next.omittedReceiptCount + next.entries.length, 30);
});
test("failed, malformed and unrelated tool results cannot fabricate completed retrieval work", () => {
  const call = pair("graph_paths", {}, pathResult)[0]!.tool_calls![0]!;
  assert.equal(
    workReceipt(call, { error: "denied", ...pathResult }),
    undefined,
  );
  assert.equal(workReceipt(call, { paths: null }), undefined);
  assert.equal(
    workReceipt(
      { ...call, function: { name: "knowledge_read", arguments: "{}" } },
      pathResult,
    ),
    undefined,
  );
  assert.equal(
    workReceipt(
      { ...call, function: { ...call.function, arguments: "bad" } },
      pathResult,
    ),
    undefined,
  );
});
test("a later empty graph search cannot evict the already discovered target route", () => {
  const w = new WorkingSet("task");
  w.add(
    workReceipt(
      pair("graph_paths", { start: "front", target: "qa" }, pathResult)[0]!
        .tool_calls![0]!,
      pathResult,
    )!,
  );
  const empty = { paths: [], mode: "transfer" };
  w.add(
    workReceipt(
      pair("graph_paths", { start: "qa" }, empty)[0]!.tool_calls![0]!,
      empty,
    )!,
  );
  const small = readWork([w.message(800)!]);
  assert(
    small.entries.some(
      (e: any) =>
        e.arguments.target === "qa" && e.summary.paths.returnedCount === 1,
    ),
  );
  assert.throws(() => w.message(50), /available context/);
});
