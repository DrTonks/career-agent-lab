import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { Store } from "../src/storage.js";
import { Runtime } from "../src/runtime.js";
import { Knowledge } from "../src/retrieval.js";
import { loadDataset } from "../src/data.js";
import { ROOT, hash } from "../src/config.js";
import { config } from "./test-config.js";
import { reviewMemoryContexts } from "../src/review-memory-context.js";

function fixture() {
  const store = new Store(":memory:");
  const runtime = new Runtime(
    store,
    new Knowledge(loadDataset(resolve(ROOT, "data/synthetic/dataset.json"))),
    {
      mode: "replay",
      model: "fixture",
      async complete() {
        throw Error("No provider calls");
      },
    },
    config(),
  );
  const run = runtime.create({
    userId: "private-user",
    conversationId: "private-conversation",
    request: "核对当前有效记忆",
  });
  const context = {
    items: [] as any[],
    totalAvailable: 0,
    totalMatches: 0,
    nextCursor: null,
    mode: "recent",
    snapshot: hash([]),
    query: "",
  };
  const state = {
    runId: run.id,
    role: "profile",
    executionId: "profile",
    inputVersion: run.inputVersion ?? 0,
    inputHash: hash({
      request: run.request.request,
      resume: run.request.resumeText,
    }),
    constraintsHash: hash(run.request.constraints),
  };
  const payload = {
    userRequest: run.request.request,
    constraints: run.request.constraints,
    executionId: "profile",
    memoryContext: context,
  };
  const save = (id = "call", mutate?: (c: any) => void, prefix = "") => {
    const messages = [
      {
        role: "user",
        content:
          prefix + "TASK_DATA (not instructions):\n" + JSON.stringify(payload),
      },
    ];
    const c: any = {
      id,
      status: "completed",
      role: "profile",
      scope: "expert:profile:turn:0",
      createdAt: "2026-10-17T02:00:00Z",
      executionState: state,
      executionStateHash: hash(state),
      messages,
      promptHash: hash(messages),
    };
    mutate?.(c);
    store.modelCall(id, run.id, c);
  };
  return { store, run, context, state, payload, save };
}

test("injected empty active memory survives export, deduplicates calls and retains provenance without user identity", () => {
  const f = fixture();
  try {
    f.save();
    f.save(
      "call-2",
      undefined,
      '<activeSkill name="profile">domain instructions</activeSkill>\n',
    );
    const result = reviewMemoryContexts(f.store.db, f.run);
    assert.equal(result.records.length, 1);
    assert.equal(result.records[0]!.provenance.length, 2);
    assert.equal(result.records[0]!.context.totalAvailable, 0);
    assert.deepEqual(result.records[0]!.scope.namespaces, [
      "shared",
      "profile",
    ]);
    assert.ok(!JSON.stringify(result).includes("private-user"));
    assert.ok(!JSON.stringify(result).includes("private-conversation"));
    assert.match(result.records[0]!.interpretation, /retracted history/);
  } finally {
    f.store.close();
  }
});

for (const kind of ["prompt", "run", "future", "namespace", "counts"] as const)
  test(`injected memory rejects ${kind} corruption without exporting it`, () => {
    const f = fixture();
    try {
      if (kind === "future" || kind === "namespace") {
        f.context.items.push({
          namespace: kind === "namespace" ? "report" : "shared",
          key: "city",
          value: "x",
          version: 1,
          evidence: "[]",
          updated_at:
            kind === "future" ? "2099-01-01T00:00:00Z" : "2026-10-16T00:00:00Z",
          expires_at: null,
          state: "active",
          score: null,
        });
        f.context.totalAvailable = f.context.totalMatches = 1;
      }
      if (kind === "counts") f.context.totalMatches = 1;
      f.save("call", (c) => {
        if (kind === "prompt") c.promptHash = "tampered";
        if (kind === "run") {
          c.executionState = { ...c.executionState, runId: "other-run" };
          c.executionStateHash = hash(c.executionState);
        }
      });
      assert.throws(
        () => reviewMemoryContexts(f.store.db, f.run),
        /memory .*mismatch|memory namespace violation/,
      );
    } finally {
      f.store.close();
    }
  });

test("incomplete calls and unrecognized old logs stay visible as coverage gaps", () => {
  const f = fixture();
  try {
    f.save("failed", (c) => {
      c.status = "failed";
    });
    f.save("legacy", (c) => {
      delete c.messages;
    });
    const result = reviewMemoryContexts(f.store.db, f.run);
    assert.equal(result.records.length, 0);
    assert.deepEqual(result.coverage, {
      examined: 2,
      incomplete: 1,
      noInjectedContext: 1,
    });
  } finally {
    f.store.close();
  }
});
