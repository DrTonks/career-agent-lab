import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { DomainTools, EvidenceRequiredError } from "../src/tools.js";
import { Store } from "../src/storage.js";
import { Runtime } from "../src/runtime.js";
import { Knowledge } from "../src/retrieval.js";
import { loadDataset } from "../src/data.js";
import { config, ROOT } from "../src/config.js";
import {
  Request,
  type Artifact,
  type ModelProvider,
  type ModelReply,
} from "../src/contracts.js";
import { finalFacts } from "../src/final-review.js";
import { reviewProvider } from "./fixtures/final-review-provider.js";
const data = loadDataset(resolve(ROOT, "data/synthetic/dataset.json"));

test("missing evidence hints enumerate readable IDs without marking them read or revealing inaccessible sources", async () => {
  const store = new Store(":memory:"),
    knowledge = new Knowledge(data);
  try {
    const run = new Runtime(store, knowledge, reviewProvider(), {
      ...config(),
      finalReview: "off",
    }).create(
      Request.parse({
        userId: "hints",
        conversationId: "c",
        request: "画像",
        resumeText: "一段简历",
      }),
    );
    const tools = new DomainTools(
      "profile",
      run,
      "profile",
      store,
      knowledge,
      [],
      new AbortController().signal,
    );
    let feedback: EvidenceRequiredError | undefined;
    try {
      tools.assertEvidence([
        "rule:profile",
        "resume:1",
        "rule:match",
        "input:other:resume",
        "resume:1",
      ]);
    } catch (e) {
      assert(e instanceof EvidenceRequiredError);
      feedback = e;
    }
    assert(feedback);
    assert.equal(tools.seen.size, 0);
    assert.equal(feedback.feedback.missing.length, 4);
    assert.deepEqual(
      feedback.feedback.missing
        .filter((h) => h.access === "unavailable")
        .map((h) => h.id),
      ["rule:match", "input:other:resume"],
    );
    assert(!JSON.stringify(feedback.feedback).includes("一段简历"));
    for (const hint of feedback.feedback.missing)
      if (hint.access === "readable")
        await tools.invoke(hint.tool, hint.arguments, hint.id);
    assert.doesNotThrow(() =>
      tools.assertEvidence(["rule:profile", "resume:1"]),
    );
    assert.throws(() => tools.assertEvidence(["rule:match"]), /Unread/);
  } finally {
    store.close();
  }
});

test("final facts preserve failed attempts separately from the current successful artifact and reject mixed-run history", () => {
  const request = Request.parse({
    userId: "u",
    conversationId: "c",
    request: "规划",
  });
  const failed: Artifact = {
    id: "r:path",
    runId: "r",
    stepId: "path",
    expert: "path",
    version: 1,
    attempt: 1,
    result: {
      status: "failed",
      summary: "轮数上限",
      evidenceIds: [],
      unknowns: [],
      conflicts: [],
      nextActions: [],
      artifact: {},
    },
    failure: { code: "expert_turn_limit", retryable: true, message: "limit" },
  };
  const current: Artifact = {
    ...failed,
    attempt: 2,
    version: 2,
    failure: undefined,
    result: { ...failed.result, status: "succeeded", summary: "完成" },
  };
  const facts = finalFacts(request, [current], "synthetic", {
    runId: "r",
    records: [
      { artifact: failed, invalidatedBy: "retry" },
      { artifact: current, invalidatedBy: null },
    ],
  });
  assert.equal(facts.steps[0]!.failure, null);
  assert.equal(facts.steps[0]!.attempt, 2);
  assert.deepEqual(
    facts.executionHistory.attempts.map((a) => [
      a.attempt,
      a.status,
      a.current,
    ]),
    [
      [1, "failed", false],
      [2, "succeeded", true],
    ],
  );
  assert.equal(
    facts.executionHistory.attempts[0]!.failure?.code,
    "expert_turn_limit",
  );
  const unavailable = finalFacts(request, [current], "synthetic");
  assert.equal(unavailable.executionHistory.available, false);
  assert.deepEqual(unavailable.executionHistory.attempts, []);
  assert.notEqual(facts.factsHash, unavailable.factsHash);
  const history = {
    runId: "r",
    records: [
      { artifact: failed, invalidatedBy: "retry" },
      { artifact: current, invalidatedBy: null },
    ],
  };
  const control = {
    roundsUsed: 2,
    roundLimit: 1,
    resolutions: [
      {
        artifactId: failed.id,
        action: "retry" as const,
        reason: "retry first attempt",
      },
      {
        artifactId: current.id,
        action: "defer" as const,
        reason: "await user information",
      },
    ],
  };
  const shared = finalFacts(request, [current], "synthetic", history, control);
  assert.deepEqual(shared.coordination.resolutions, control.resolutions);
  assert.deepEqual(shared.coordination.invalidatedArtifactIds, [failed.id]);
  assert.equal(shared.coordination.roundsUsed, 2); // terminal defer can exceed replanning cutoff
  assert.equal(unavailable.coordination.roundsUsed, null);
  assert.equal(unavailable.coordination.available, false);
  assert.notEqual(shared.factsHash, facts.factsHash);
  assert.throws(
    () =>
      finalFacts(request, [current], "synthetic", history, {
        ...control,
        roundsUsed: 0,
      }),
    /round count/,
  );
  assert.throws(
    () =>
      finalFacts(request, [current], "synthetic", history, {
        ...control,
        resolutions: [
          { ...control.resolutions[0]!, artifactId: "other:artifact" },
        ],
      }),
    /outside the execution history/,
  );
  assert.throws(
    () => finalFacts(request, [current], "synthetic", undefined, control),
    /outside the execution history/,
  );
  assert.throws(
    () =>
      finalFacts(request, [current], "synthetic", {
        runId: "other",
        records: [{ artifact: failed, invalidatedBy: null }],
      }),
    /another run/,
  );
});

for (const architecture of ["multi-agent", "skills"] as const)
  test(`${architecture}: rejected citation leads to real authorized reads before resubmission`, async () => {
    const store = new Store(":memory:");
    let turns = 0;
    const call = (name: string, args: unknown): ModelReply => ({
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: `${name}-${turns}`,
            type: "function",
            function: { name, arguments: JSON.stringify(args) },
          },
        ],
      },
      usage: { input: 10, output: 10, cachedInput: 0 },
      finishReason: "tool_calls",
    });
    const provider: ModelProvider = {
      mode: "replay",
      model: "evidence-feedback-fixture",
      async complete(messages, definitions) {
        if (definitions.some((t) => t.function.name === "plan_submit"))
          return call("plan_submit", {
            rationale: "匹配",
            steps: [
              {
                id: "match",
                expert: "match",
                objective: "匹配",
                dependsOn: [],
              },
            ],
          });
        if (definitions.some((t) => t.function.name === "expert_finish")) {
          turns++;
          if (turns === 2) {
            const feedback = JSON.parse(messages.at(-1)!.content!);
            assert.equal(feedback.code, "evidence_required");
            assert.equal(feedback.missing.length, 2);
            const reply = call("unused", {});
            reply.message.tool_calls = feedback.missing.map(
              (hint: any, i: number) => {
                assert.equal(hint.access, "readable");
                return {
                  id: `read-${i}`,
                  type: "function",
                  function: {
                    name: hint.tool,
                    arguments: JSON.stringify(hint.arguments),
                  },
                };
              },
            );
            return reply;
          }
          return call("expert_finish", {
            status: "succeeded",
            summary: "合成匹配",
            evidenceIds: ["rule:match", "job:synthetic-1-1"],
            unknowns: [],
            conflicts: [],
            nextActions: [],
            artifact: {
              rankedJobs: [
                { id: "synthetic-1-1", reason: "合成样本", gaps: [] },
              ],
            },
          });
        }
        return {
          message: { role: "assistant", content: "状态说明" },
          usage: { input: 10, output: 10, cachedInput: 0 },
          finishReason: "stop",
        };
      },
    };
    try {
      const runtime = new Runtime(store, new Knowledge(data), provider, {
        ...config(),
        finalReview: "off",
      });
      const run = runtime.create(
        Request.parse({
          userId: "feedback",
          conversationId: "c",
          request: "匹配",
          architecture,
        }),
      );
      const done = await runtime.execute(run.id, run.request.userId);
      assert.equal(done.status, "succeeded", done.error);
      assert.equal(turns, 3);
      const events = store.events(run.id);
      assert.equal(
        events.filter(
          (e) =>
            e.type === "tool.failed" &&
            (e.payload as any).feedback?.code === "evidence_required",
        ).length,
        1,
      );
      assert.equal(
        events.filter(
          (e) =>
            e.type === "tool.completed" &&
            (e.payload as any).name === "knowledge_read",
        ).length,
        2,
      );
      assert.equal(store.artifactHistory(run.id).length, 1);
    } finally {
      store.close();
    }
  });
