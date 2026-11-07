import test from "node:test";
import assert from "node:assert/strict";
import {
  expertReviewContext,
  type ReviewContext,
} from "../src/review-context.js";
const base: ReviewContext = {
  schemaVersion: "memory-probe-integration-v1",
  catalog: [{ id: "job:a", title: "A" }],
  priorConclusions: [
    { id: "a", role: "match", version: 1, summary: "old match" },
    {
      id: "b",
      role: "profile",
      version: 1,
      summary: "private profile summary",
    },
  ],
  tasks: [
    {
      key: "duration",
      question: "Can the student commit six months?",
      targets: ["match", "report"],
      refs: ["job:a"],
      binding: { artifactIds: ["a"] },
      status: "needs-refresh",
    },
  ],
};
test("expert review context filters role targets and does not grant evidence or broadcast hypotheses", () => {
  const data = {
    ...base,
    tasks: base.tasks.map((t) => ({
      ...t,
      branches: [{ condition: "invented future", consequence: "eligible" }],
    })),
  };
  const context = expertReviewContext(data, "match")!;
  assert.equal(context.tasks.length, 1);
  assert.equal(JSON.stringify(context).includes("invented future"), false);
  assert.equal(context.priorConclusions.length, 1);
  assert.equal(expertReviewContext(base, "profile")!.tasks.length, 0);
  assert.equal(expertReviewContext(undefined, "match"), undefined);
  assert.equal(base.tasks[0]!.status, "needs-refresh");
});
test("requested source IDs reach only the assigned expert without granting source access", () => {
  const data = {
    ...base,
    tasks: base.tasks.map((t) => ({ ...t, requestedEvidence: ["job:new"] })),
  };
  assert.deepEqual(
    expertReviewContext(data, "match")!.tasks[0]!.requestedEvidence,
    ["job:new"],
  );
  assert.equal(expertReviewContext(data, "profile")!.tasks.length, 0);
  assert.equal(
    JSON.stringify(expertReviewContext(data, "match")).includes(
      "publishedEvidence",
    ),
    false,
  );
});
test("derived check receipts survive role context projection without adding evidence permissions", () => {
  const data = {
    ...base,
    derivationChecks: [
      { id: "schedule:test", weeklyHours: 18, scope: "calendar arithmetic" },
    ],
  };
  const c = expertReviewContext(data, "match")!;
  assert.equal(c.derivationChecks![0]!.weeklyHours, 18);
  assert.equal(JSON.stringify(c).includes("publishedEvidence"), false);
});
