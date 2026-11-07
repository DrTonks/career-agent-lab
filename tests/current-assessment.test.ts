import test from "node:test";
import assert from "node:assert/strict";
import {
  CurrentAssessment,
  checkAssessmentBinding,
} from "../src/current-assessment.js";
import { ExpertResult } from "../src/contracts.js";
import { hash } from "../src/config.js";
import {
  evaluateTimeRule,
  verifyTimeRefutation,
} from "../src/time-refutation.js";
const rule = {
    monthsAtLeast: 3,
    daysAtLeast: 2,
    qualifyingDays: { count: 2, hoursAtLeast: 4 },
  },
  facts = {
    months: 6,
    dailyHours: { mon: 7, tue: 0, wed: 7, thu: 0, fri: 3.5, sat: 0, sun: 0 },
  };
const a = {
  schemaVersion: "current-assessment-v1" as const,
  factsVersion: "v1",
  weeklyHours: 17.5,
  judgments: [
    { jobId: "b", ruleVersion: hash(rule), verdict: "符合" as const },
  ],
  evidenceIds: ["event:0", "job:b"],
};
const expected = {
  factsVersion: "v1",
  weeklyHours: 17.5,
  ruleVersions: { b: hash(rule) },
  evidenceIds: ["event:0", "job:b"],
};
test("current assessment survives historical prose and rejects stale/unknown bindings or wrong values", () => {
  const r = ExpertResult.parse({
    status: "partial",
    summary: "旧周工时=25已作废；现在7+7+3.5=17.5",
    evidenceIds: [],
    unknowns: [],
    conflicts: [],
    nextActions: [],
    artifact: {},
    currentAssessment: a,
  });
  assert.equal(r.currentAssessment?.weeklyHours, 17.5);
  assert.equal(
    checkAssessmentBinding(r.currentAssessment, expected).valid,
    true,
  );
  for (const invalid of [
    { ...a, factsVersion: "v0" },
    { ...a, weeklyHours: 25 },
    { ...a, evidenceIds: ["invented"] },
    { ...a, judgments: [] },
    { ...a, judgments: [a.judgments[0], a.judgments[0]] },
  ])
    assert.equal(checkAssessmentBinding(invalid, expected).valid, false);
  assert.throws(() => CurrentAssessment.parse({ ...a, weeklyHours: 999 }));
});
test("two qualifying days is not the same predicate as every working day qualifying", () => {
  assert.equal(evaluateTimeRule(rule, facts).verdict, "符合");
  assert.equal(
    evaluateTimeRule(
      { monthsAtLeast: 3, daysAtLeast: 2, everyWorkingDayHoursAtLeast: 4 },
      facts,
    ).verdict,
    "不符",
  );
});
test("a change is a counterexample only when it changes the bound rule decision", () => {
  const before = { ...facts, dailyHours: { ...facts.dailyHours, fri: 4.5 } },
    base = {
      jobId: "b",
      rule,
      ruleVersion: hash(rule),
      factsVersion: "v1",
      before,
      after: facts,
    };
  const p = {
    jobId: "b",
    ruleVersion: hash(rule),
    factsVersion: "v1",
    predictedAfter: "不符",
    claimsRefutation: true,
  };
  assert.equal(verifyTimeRefutation({ ...base, proposal: p }).valid, false);
  assert.equal(
    verifyTimeRefutation({
      ...base,
      proposal: { ...p, predictedAfter: "符合", claimsRefutation: false },
    }).status,
    "verified-non-refutation",
  );
  const decisive = { ...facts, dailyHours: { ...facts.dailyHours, wed: 3 } };
  assert.equal(
    verifyTimeRefutation({
      ...base,
      before: facts,
      after: decisive,
      proposal: p,
    }).status,
    "verified-refutation",
  );
  assert.equal(
    verifyTimeRefutation({ ...base, proposal: { ...p, factsVersion: "old" } })
      .status,
    "binding-rejected",
  );
  assert.equal(before.dailyHours.fri, 4.5);
});
test("missing facts do not produce a verified business refutation; known violations remain violations", () => {
  assert.equal(
    evaluateTimeRule(rule, { ...facts, months: null }).verdict,
    "待核定",
  );
  assert.equal(
    evaluateTimeRule(rule, {
      months: null,
      dailyHours: { ...facts.dailyHours, mon: 0, wed: 0 },
    }).verdict,
    "不符",
  );
  assert.throws(() =>
    evaluateTimeRule({ ...rule, unsupportedCondition: true }, facts),
  );
});
import { Store } from "../src/storage.js";
import { Runtime } from "../src/runtime.js";
import { DomainTools } from "../src/tools.js";
import { Knowledge } from "../src/retrieval.js";
import { loadDataset } from "../src/data.js";
import { ROOT } from "../src/config.js";
import { ReplayProvider } from "../src/providers.js";
import { config } from "./test-config.js";
test("native expert_finish preserves separate assessment and does not grant unread evidence", async () => {
  const store = new Store(":memory:");
  try {
    const knowledge = new Knowledge(
      loadDataset(ROOT + "/data/synthetic/dataset.json"),
    );
    const rt = new Runtime(store, knowledge, new ReplayProvider([]), config());
    const run = rt.create({
      userId: "assessment-user",
      conversationId: "c",
      request: "当前日程在本轮用户输入中",
    });
    const tools = new DomainTools(
      "match",
      run,
      "match",
      store,
      knowledge,
      [],
      new AbortController().signal,
    );
    const source = "input:" + run.id + ":request";
    const value = {
      status: "needs_input",
      summary: "历史周工时=25，当前值独立存储",
      evidenceIds: [],
      unknowns: [],
      conflicts: [],
      nextActions: [],
      artifact: {},
      currentAssessment: { ...a, evidenceIds: [source] },
    };
    await assert.rejects(tools.invoke("expert_finish", value, "unread"));
    await tools.invoke(
      "input_read",
      { source: "request", offset: 0, maxChars: 4000 },
      "read",
    );
    await tools.invoke("expert_finish", value, "finish");
    assert.equal(tools.result?.currentAssessment?.weeklyHours, 17.5);
    store.saveArtifact({
      id: run.id + ":match",
      runId: run.id,
      stepId: "match",
      expert: "match",
      version: 1,
      result: tools.result!,
    });
    assert.equal(
      store.artifacts(run.id)[0]!.result.currentAssessment?.factsVersion,
      "v1",
    );
  } finally {
    store.close();
  }
});
