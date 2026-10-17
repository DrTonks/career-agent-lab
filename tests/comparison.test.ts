import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  ComparisonSuite,
  prepareComparison,
  verifyComparison,
  executeComparisonUnit,
} from "../src/comparison.js";
import { ROOT } from "../src/config.js";
import { Store } from "../src/storage.js";
import { ReplayProvider } from "../src/providers.js";
import { config } from "./test-config.js";
import type { ModelReply } from "../src/contracts.js";
import { analyzeComparison } from "../src/comparison-analysis.js";
import { prepareConversationMaterials } from "../src/blind-conversations.js";
function directory() {
  mkdirSync(resolve(ROOT, "var/tests"), { recursive: true });
  return resolve(mkdtempSync(resolve(ROOT, "var/tests/comparison-")), "batch");
}
test("unified runtime records export through the conversation reviewer without rewriting the experiment", async () => {
  const out = directory(),
    plan = prepareComparison(out, suite(), cfg());
  for (const unit of plan.units) {
    const replay = new ReplayProvider(comparisonReplies());
    await executeComparisonUnit(out, unit.id, {
      mode: "live",
      model: replay.model,
      complete: (messages, tools, signal, delta) =>
        replay.complete(messages, tools, signal, delta),
    });
  }
  const pair = resolve(out, "pairs/conversation-control-r0");
  const before = readFileSync(resolve(pair, "scenario.json"), "utf8");
  const material = prepareConversationMaterials(pair, 73);
  assert.equal(material.bundle.cases.length, 2);
  assert.equal(material.bundle.version, "blind-review-v2-candidate-sources");
  assert.equal(readFileSync(resolve(pair, "scenario.json"), "utf8"), before);
});
const suite = () =>
  ComparisonSuite.parse({
    schemaVersion: "comparison-suite-v1",
    name: "offline-pipeline-control",
    split: "development",
    seed: 20261016,
    repeats: 1,
    cases: [
      {
        id: "conversation-control",
        stratum: "conversation",
        first: {
          userId: "u",
          conversationId: "c",
          request: "仅画像",
          approvalRequired: false,
        },
        replies: [{ operationId: "reply", reply: "仍需补充" }],
        approval: "none",
        expected: { requiredRoles: ["profile"], checks: ["合理未知"] },
      },
    ],
  });
const cfg = () => ({
  ...config(),
  model: "fixture-replay-not-an-llm",
  leaseTtlMs: 1000,
});
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
export function comparisonReplies() {
  return Array.from({ length: 2 }, () => [
    call("plan_submit", {
      rationale: "核对",
      steps: [
        {
          id: "profile",
          expert: "profile",
          objective: "核对材料",
          dependsOn: [],
        },
      ],
    }),
    call("input_read", { source: "request" }),
    call("input_read", { source: "resume" }),
    call("expert_finish", {
      status: "needs_input",
      summary: "需要具体材料",
      evidenceIds: [],
      unknowns: [],
      conflicts: [],
      nextActions: [],
      artifact: {},
    }),
    {
      reply: {
        message: { role: "assistant" as const, content: "需要具体材料" },
        usage: { input: 10, output: 10, cachedInput: 0 },
        finishReason: "stop",
      },
    },
  ]).flat();
}
test("comparison preparation freezes reproducible balanced order and rejects overwrites, duplicate IDs and source drift", () => {
  const out = directory(),
    s = suite();
  s.repeats = 2;
  const p = prepareComparison(out, s, cfg());
  assert.equal(p.units.length, 4);
  assert.notEqual(p.units[0]!.architecture, p.units[2]!.architecture);
  assert.equal(verifyComparison(out).hash, p.hash);
  assert.throws(() => prepareComparison(out, s, cfg()), /already exists/);
  assert(
    !ComparisonSuite.safeParse({ ...s, cases: [s.cases[0], s.cases[0]] })
      .success,
  );
  writeFileSync(resolve(out, "snapshot/prompts/common.md"), "changed");
  assert.throws(() => verifyComparison(out), /snapshot changed/);
});
test("paired conversation execution uses real runtime, independent identities, complete records and idempotent terminal restart", async () => {
  const out = directory(),
    p = prepareComparison(out, suite(), cfg());
  for (const unit of p.units) {
    const done = await executeComparisonUnit(
      out,
      unit.id,
      new ReplayProvider(comparisonReplies()),
    );
    assert.equal(done.status, "completed");
    await executeComparisonUnit(out, unit.id, new ReplayProvider([]));
  }
  const pair = resolve(out, "pairs/conversation-control-r0"),
    rows = JSON.parse(readFileSync(resolve(pair, "records.json"), "utf8"));
  assert.equal(rows.length, 4);
  const status = JSON.parse(readFileSync(resolve(out, "status.json"), "utf8"));
  const analysis = analyzeComparison(p, status.units, rows);
  assert.equal(analysis.scheduledUnits, 2);
  assert.equal(
    analysis.pairedCaseDifferences[0]!.metrics.modelCalls!.pairedRepeats,
    1,
  );
  const incomplete = analyzeComparison(p, status.units, [
    { ...rows[0], inputTokens: null },
  ]);
  assert.equal(
    incomplete.units.reduce((n, u) => n + u.missingTurns, 0),
    3,
  );
  assert(incomplete.units.every((u) => u.metrics.inputTokens === null));
  assert.equal(
    incomplete.pairedCaseDifferences[0]!.metrics.inputTokens!.pairedRepeats,
    0,
  );
  assert(
    rows.every((r: any) => r.mode === "replay" && r.qualityScore === null),
  );
  const store = new Store(resolve(pair, "runs.sqlite"));
  try {
    assert.equal(
      store.db.prepare("SELECT count(*) AS n FROM runs").get()!.n,
      4,
    );
    assert.equal(
      store.db.prepare("SELECT count(DISTINCT user_id) AS n FROM runs").get()!
        .n,
      2,
    );
    assert.equal(
      store.db.prepare("SELECT count(*) AS n FROM model_calls").get()!.n,
      20,
    );
  } finally {
    store.close();
  }
});
test("failed parent retains failure and blocks dependent turns instead of inventing successful records", async () => {
  const out = directory(),
    p = prepareComparison(out, suite(), cfg()),
    u = p.units[0]!;
  const done = await executeComparisonUnit(out, u.id, new ReplayProvider([]));
  assert.equal(done.status, "blocked");
  assert.equal(done.blockedTurns, 1);
  const rows = JSON.parse(
    readFileSync(
      resolve(out, "pairs/conversation-control-r0/records.json"),
      "utf8",
    ),
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "failed");
});
test("comparison CLI refuses execution without explicit live and synthetic authorization", () => {
  const out = directory(),
    p = prepareComparison(out, suite(), cfg());
  const child = spawnSync(
    process.execPath,
    [
      resolve(ROOT, "dist/scripts/compare.js"),
      "--plan",
      out,
      "--unit",
      p.units[0]!.id,
    ],
    { encoding: "utf8", windowsHide: true, timeout: 20000 },
  );
  assert.notEqual(child.status, 0);
  assert.match(child.stderr, /requires --live --confirm-public-synthetic/);
  assert.equal(
    JSON.parse(readFileSync(resolve(out, "status.json"), "utf8")).units[0]
      .status,
    "scheduled",
  );
});

test("actual process termination preserves an unknown request and resumes the same comparison root", () => {
  const out = directory(),
    plan = prepareComparison(out, suite(), cfg()),
    unit = plan.units[0]!;
  const fixture = resolve(out, "replay.json");
  writeFileSync(fixture, JSON.stringify(comparisonReplies()));
  for (const mode of ["crash", "recover"]) {
    const child = spawnSync(
      process.execPath,
      [
        resolve(ROOT, "dist/tests/fixtures/comparison-worker.js"),
        out,
        unit.id,
        fixture,
        mode,
      ],
      { encoding: "utf8", windowsHide: true, timeout: 30000 },
    );
    writeFileSync(
      resolve(out, `${mode}.json`),
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
      assert.match(child.stdout, /COMPARISON_ROOT_CREATED/);
    } else assert.equal(child.status, 0, child.stderr);
  }
  const store = new Store(
    resolve(out, "pairs/conversation-control-r0/runs.sqlite"),
  );
  try {
    assert.equal(
      store.db.prepare("SELECT count(*) AS n FROM runs").get()!.n,
      2,
    );
    const rows = JSON.parse(
      readFileSync(
        resolve(out, "pairs/conversation-control-r0/records.json"),
        "utf8",
      ),
    );
    assert.equal(rows.length, 2);
    assert(rows[0].unknownUsageCalls > 0);
    assert.equal(rows[0].inputTokens, null);
  } finally {
    store.close();
  }
});
