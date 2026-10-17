import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { Store } from "../src/storage.js";
import { Runtime } from "../src/runtime.js";
import { Knowledge } from "../src/retrieval.js";
import { loadDataset } from "../src/data.js";
import { ROOT } from "../src/config.js";
import { ReplayProvider } from "../src/providers.js";
import { Clarifications } from "../src/clarification.js";
import { followUpInput } from "../src/follow-up.js";
import type { Artifact, ExpertResult } from "../src/contracts.js";
import { config } from "./test-config.js";
const result = (unknowns: string[]): ExpertResult => ({
  status: "failed",
  summary: "待补充",
  evidenceIds: [],
  unknowns,
  conflicts: [],
  nextActions: [],
  artifact: {},
});
const knowledge = new Knowledge(
  loadDataset(resolve(ROOT, "data/synthetic/dataset.json")),
);
function artifact(runId: string, id: string, unknowns: string[]): Artifact {
  return {
    id: `${runId}:${id}`,
    runId,
    stepId: id,
    expert: "profile",
    version: 1,
    result: result(unknowns),
  };
}
test("full open-question ledger survives summary truncation and multiple replies without exponential duplication", () => {
  const store = new Store(":memory:");
  try {
    const rt = new Runtime(store, knowledge, new ReplayProvider([]), config());
    let parent = rt.create({
      userId: "u",
      conversationId: "c",
      request: "画像",
    });
    const expected = Array.from({ length: 40 }, (_, i) => `待补字段 ${i}`);
    store.saveArtifact(artifact(parent.id, "p1", expected.slice(0, 20)));
    store.saveArtifact(artifact(parent.id, "p2", expected.slice(20)));
    for (let turn = 0; turn < 4; turn++) {
      store.update(parent.id, { status: "partial" });
      const child = rt.reply(parent.id, "u", {
        operationId: `r${turn}`,
        reply: "目前未补充",
      });
      const clarifications = new Clarifications(
        store,
        child,
        "profile",
        "profile",
      );
      assert.deepEqual(
        clarifications.questions.map((q) => q.text),
        expected,
      );
      const r = result([]);
      r.artifact.openQuestions = {
        schemaVersion: "open-questions-v1",
        items: ["INJECTED"],
      };
      clarifications.attach(r, new Map(), false);
      assert.equal(r.unknowns.length, 30);
      assert.deepEqual((r.artifact.openQuestions as any).items, expected);
      store.saveArtifact({ ...artifact(child.id, "profile", []), result: r });
      parent = child;
    }
  } finally {
    store.close();
  }
});
test("question deduplication removes only whitespace-equivalent repeats within an artifact, not different questions or roles", () => {
  const store = new Store(":memory:");
  try {
    const rt = new Runtime(store, knowledge, new ReplayProvider([]), config());
    const parent = rt.create({
      userId: "u",
      conversationId: "c",
      request: "画像",
    });
    const a = artifact(parent.id, "profile", [
      "学校 名称",
      " 学校  名称 ",
      "学校名称？",
      "实习时长",
      "全职时长",
    ]);
    const b = {
      ...artifact(parent.id, "match", ["学校 名称"]),
      expert: "match" as const,
    };
    const next = followUpInput(parent, { operationId: "r", reply: "补充" }, [
      a,
      b,
    ]);
    assert.equal(next.continuation.questions.length, 5);
    assert.equal(
      next.continuation.questionPolicy,
      "complete-open-questions-v1",
    );
    const old = followUpInput(
      parent,
      { operationId: "r", reply: "补充" },
      [a, b],
      "user-reply-v2",
      "legacy",
    );
    assert.equal(old.continuation.questions.length, 6);
    assert.equal(old.continuation.questionPolicy, undefined);
  } finally {
    store.close();
  }
});
test("first-turn model-supplied open-question metadata is overwritten by actual unresolved output", () => {
  const store = new Store(":memory:");
  try {
    const rt = new Runtime(store, knowledge, new ReplayProvider([]), config());
    const run = rt.create({
      userId: "u",
      conversationId: "c",
      request: "画像",
    });
    const r = result(["真实未解决问题"]);
    r.artifact.openQuestions = {
      schemaVersion: "open-questions-v1",
      items: ["伪造问题"],
    };
    new Clarifications(store, run, "profile", "profile").attach(
      r,
      new Map(),
      false,
    );
    assert.deepEqual((r.artifact.openQuestions as any).items, [
      "真实未解决问题",
    ]);
  } finally {
    store.close();
  }
});
