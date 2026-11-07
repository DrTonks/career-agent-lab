import test from "node:test";
import assert from "node:assert/strict";
import { historicalReviewArtifacts } from "../src/historical-review.js";
import { Store } from "../src/storage.js";
import { Runtime } from "../src/runtime.js";
import { Knowledge } from "../src/retrieval.js";
import { ReplayProvider } from "../src/providers.js";
import { loadDataset } from "../src/data.js";
import { config } from "./test-config.js";
import { ROOT } from "../src/config.js";
import type { Artifact } from "../src/contracts.js";
const result = {
  status: "succeeded" as const,
  summary: "old verdict",
  evidenceIds: ["old-source"],
  unknowns: [],
  conflicts: [],
  nextActions: [],
  artifact: {},
};
test("ancestor access is opt-in, preserves original IDs and strips inherited source grants", () => {
  const s = new Store(":memory:");
  try {
    const k = new Knowledge(loadDataset(ROOT + "/data/synthetic/dataset.json"));
    const rt = new Runtime(s, k, new ReplayProvider([]), config());
    const parent = rt.create({
      userId: "u",
      conversationId: "c",
      request: "initial",
    });
    const a: Artifact = {
      id: "a",
      runId: parent.id,
      stepId: "match",
      expert: "match",
      version: 1,
      result,
      publishedEvidence: [
        {
          id: "old-source",
          kind: "job",
          sourceId: "a",
          text: "stale data",
          version: "v0",
        },
      ],
    };
    s.saveArtifact(a);
    s.update(parent.id, { status: "succeeded" });
    const child = rt.reply(parent.id, "u", {
      operationId: "next",
      reply: "changed",
    });
    assert.deepEqual((rt as any).priorArtifacts(child), []);
    const found = historicalReviewArtifacts(s, child);
    assert.equal(found.length, 1);
    assert.equal(found[0]!.id, "a");
    assert.deepEqual(found[0]!.publishedEvidence, []);
    assert.match(found[0]!.result.summary, /尚未针对本轮验证/);
    assert.equal(s.artifacts(parent.id)[0]!.result.summary, "old verdict");
    assert.throws(
      () =>
        historicalReviewArtifacts(s, {
          ...child,
          request: { ...child.request, conversationId: "other" },
        }),
      /conversation mismatch/,
    );
    assert.throws(() =>
      historicalReviewArtifacts(s, {
        ...child,
        request: { ...child.request, userId: "other" },
      }),
    );
    s.update(child.id, { status: "succeeded" });
    const grandchild = rt.reply(child.id, "u", {
      operationId: "third",
      reply: "nothing changed",
    });
    assert.equal(historicalReviewArtifacts(s, grandchild)[0]!.id, "a");
  } finally {
    s.close();
  }
});
