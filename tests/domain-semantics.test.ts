import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import {
  Constraints,
  Request,
  PROFILE_SCORING_VERSION,
} from "../src/contracts.js";
import { Knowledge, jobConstraintCheck } from "../src/retrieval.js";
import { loadDataset } from "../src/data.js";
import { ROOT } from "../src/config.js";
import { config } from "./test-config.js";
import { Store } from "../src/storage.js";
import { Runtime } from "../src/runtime.js";
import { ReplayProvider } from "../src/providers.js";
import { DomainTools } from "../src/tools.js";
const data = loadDataset(resolve(ROOT, "data/synthetic/dataset.json"));
const job = data.jobs[0]!;
test("hard condition results distinguish absent requests, failed checks and missing source values", () => {
  const none = jobConstraintCheck(
    job,
    Constraints.parse({ education: "不限" }),
  );
  assert(none.eligible);
  assert(none.checks.every((c) => c.status === "not_requested"));
  const checked = jobConstraintCheck(
    { ...job, city: "", salaryMin: null },
    Constraints.parse({
      cities: ["成都"],
      minMonthlySalary: 6000,
      education: "本科",
      experienceYears: 0,
      weekendsOff: true,
    }),
  );
  assert(!checked.eligible);
  assert(
    checked.unknowns.includes("city") && checked.unknowns.includes("salary"),
  );
  assert.equal(
    checked.checks.find((c) => c.field === "salary")!.status,
    "unknown",
  );
  const failed = jobConstraintCheck(
    { ...job, city: "成都市", salaryMin: 5000 },
    Constraints.parse({ cities: ["成都市"], minMonthlySalary: 6000 }),
  );
  assert.equal(
    failed.checks.find((c) => c.field === "city")!.status,
    "satisfied",
  );
  assert.equal(
    failed.checks.find((c) => c.field === "salary")!.status,
    "violated",
  );
});
test("zero and false are explicit constraints rather than missing requests", () => {
  const c = jobConstraintCheck(
    { ...job, weekendsOff: false, experienceMin: 0, salaryMin: 0 },
    Constraints.parse({
      minMonthlySalary: 0,
      experienceYears: 0,
      weekendsOff: false,
    }),
  );
  assert(c.eligible);
  for (const field of ["salary", "experience", "weekendsOff"])
    assert.equal(c.checks.find((x) => x.field === field)!.status, "satisfied");
});
test("scoring requires personal evidence, explicit absence and non-duplicated observations; restoration keeps v2", async () => {
  const s = new Store(":memory:"),
    k = new Knowledge(data);
  try {
    const r = new Runtime(s, k, new ReplayProvider([]), config()).create(
      Request.parse({
        userId: "rubric",
        conversationId: "c",
        request: "画像",
        resumeText: "无企业实习。\n使用 Vue 完成校园项目。",
      }),
    );
    const t = new DomainTools(
      "profile",
      r,
      "profile",
      s,
      k,
      [],
      new AbortController().signal,
    );
    await t.invoke("resume_read", {}, "resume");
    await t.invoke("knowledge_read", { id: "rule:profile" }, "rule");
    const obs = {
      dimension: "internship",
      level: 0,
      confidence: 1,
      evidenceId: "resume:1",
      quote: "无企业实习",
      rationale: "明确无企业实习",
    };
    await assert.rejects(
      t.invoke("profile_score", { observations: [obs] }, "zero"),
      /explicit_absence/,
    );
    await assert.rejects(
      t.invoke(
        "profile_score",
        {
          observations: [
            {
              ...obs,
              evidenceId: "rule:profile",
              quote: "企业实习",
              basis: "explicit_absence",
            },
          ],
        },
        "rule-score",
      ),
      /user-source/,
    );
    await assert.rejects(
      t.invoke(
        "profile_score",
        { observations: [{ ...obs, level: 2, basis: "explicit_absence" }] },
        "positive-absence",
      ),
      /absence/,
    );
    const project = {
      dimension: "professionalSkill",
      level: 2,
      confidence: 1,
      evidenceId: "resume:2",
      quote: "使用 Vue 完成校园项目",
      rationale: "个人项目",
    };
    await assert.rejects(
      t.invoke(
        "profile_score",
        { observations: [project, project] },
        "duplicate",
      ),
      /Duplicate/,
    );
    const scored = (await t.invoke(
      "profile_score",
      { observations: [{ ...obs, basis: "explicit_absence" }, project] },
      "valid",
    )) as any;
    assert.equal(scored.scoringVersion, PROFILE_SCORING_VERSION);
    assert.equal(scored.scores.internship, 0);
    assert.equal(scored.scores.professionalSkill, 50);
    assert.equal(scored.scores.learning, null);
    const recovered = new DomainTools(
      "profile",
      r,
      "profile",
      s,
      k,
      [],
      new AbortController().signal,
    );
    recovered.remember([...t.seen.values()]);
    recovered.remember(scored);
    const result: any = {
      status: "partial",
      summary: "无企业实习，有校园项目",
      evidenceIds: ["resume:1", "resume:2", "rule:profile"],
      unknowns: [],
      conflicts: [],
      nextActions: [],
      artifact: {
        scores: scored.scores,
        skills: ["Vue"],
        evidence: [
          {
            dimension: "professionalSkill",
            evidenceId: "resume:2",
            quote: project.quote,
          },
        ],
      },
    };
    await recovered.invoke("expert_finish", result, "finish");
    assert.equal(
      recovered.result!.artifact.scoringVersion,
      PROFILE_SCORING_VERSION,
    );
  } finally {
    s.close();
  }
});
test("synthetic job checks say recruitment is inapplicable and salary was not requested", async () => {
  const s = new Store(":memory:"),
    k = new Knowledge(data);
  try {
    const r = new Runtime(s, k, new ReplayProvider([]), config()).create(
      Request.parse({
        userId: "fixture",
        conversationId: "c",
        request: "匹配",
        constraints: { cities: [job.city] },
      }),
    );
    const t = new DomainTools(
      "match",
      r,
      "match",
      s,
      k,
      [],
      new AbortController().signal,
    );
    const found = (await t.invoke(
      "jobs_search",
      { query: "Vue", categoryIds: ["frontend-junior"], limit: 10 },
      "search",
    )) as any;
    assert.equal(found.dataScope.recruitmentStatus, "not_applicable");
    assert.equal(found.dataScope.actionableVacancies, false);
    const checked = (await t.invoke(
      "jobs_check",
      { jobIds: [job.id], observedSkills: [] },
      "check",
    )) as any;
    assert.equal(checked.dataScope.recruitmentStatus, "not_applicable");
    assert.equal(
      checked.results[0].checks.find((x: any) => x.field === "salary").status,
      "not_requested",
    );
  } finally {
    s.close();
  }
});
