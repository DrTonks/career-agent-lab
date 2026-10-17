import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { backup } from "node:sqlite";
import { Store } from "../src/storage.js";
import { Runtime } from "../src/runtime.js";
import { Knowledge } from "../src/retrieval.js";
import { ReplayProvider } from "../src/providers.js";
import { loadDataset } from "../src/data.js";
import { ROOT } from "../src/config.js";
import { config } from "./test-config.js";
import { Request, Dimensions, type ModelReply } from "../src/contracts.js";

const data = loadDataset(resolve(ROOT, "data/synthetic/dataset.json"));
const call = (name: string, args: unknown): { reply: ModelReply } => ({
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
});
const answer: { reply: ModelReply } = {
  reply: {
    message: {
      role: "assistant",
      content: "按当前已确认事实完成，未确认部分保留未知。",
    },
    usage: { input: 10, output: 10, cachedInput: 0 },
    finishReason: "stop",
  },
};
const plan = (role: string) =>
  call("plan_submit", {
    rationale: "按本轮任务执行",
    steps: [
      { id: role, expert: role, objective: "本轮职业任务", dependsOn: [] },
    ],
  });
const need = () =>
  call("expert_finish", {
    status: "needs_input",
    summary: "等待确认偏好",
    evidenceIds: [],
    unknowns: ["下一步目标"],
    conflicts: [],
    nextActions: [],
    artifact: {},
  });

for (const architecture of ["multi-agent", "skills"] as const) {
  test(`${architecture}: durable multi-turn story approves, changes city, corrects, retracts and forgets without reviving old facts`, async () => {
    mkdirSync(resolve(ROOT, "var/tests"), { recursive: true });
    const dir = mkdtempSync(resolve(ROOT, "var/tests/multiturn-")),
      db = resolve(dir, "runs.sqlite");
    let s = new Store(db);
    const ids: string[] = [];
    const req = Request.parse({
      userId: `story-${architecture}`,
      conversationId: "career",
      request: "建立画像并记住城市偏好成都",
      resumeText: "使用 Vue 完成网页项目。希望在成都工作。",
      architecture,
      constraints: {
        cities: ["成都"],
        education: "本科",
        experienceYears: 0,
        weekendsOff: true,
      },
    });
    const rt = (replies: { reply: ModelReply }[]) =>
      new Runtime(
        s,
        new Knowledge(data),
        new ReplayProvider(replies),
        config(),
      );
    const reopen = () => {
      s.close();
      s = new Store(db);
    };
    try {
      let engine = rt([
        plan("profile"),
        call("resume_read", {}),
        call("knowledge_read", { id: "rule:profile" }),
        call("profile_score", {
          observations: [
            {
              dimension: "professionalSkill",
              level: 2,
              confidence: 1,
              evidenceId: "resume:1",
              quote: "Vue",
              rationale: "有项目实践",
            },
          ],
        }),
        call("memory_propose", {
          namespace: "shared",
          key: "city",
          value: "成都",
          expectedVersion: 0,
          evidenceIds: ["resume:1"],
        }),
        call("expert_finish", {
          status: "partial",
          summary: "OLD_GOAL_ADVICE：只考虑成都；项目事实可保留",
          evidenceIds: ["resume:1", "rule:profile"],
          unknowns: ["软能力无行为证据"],
          conflicts: [],
          nextActions: [],
          artifact: {
            scores: Object.fromEntries(
              Dimensions.map((d) => [d, d === "professionalSkill" ? 50 : null]),
            ),
            skills: ["Vue"],
            evidence: [
              {
                dimension: "professionalSkill",
                evidenceId: "resume:1",
                quote: "Vue",
              },
            ],
          },
        }),
      ]);
      const first = engine.create({ ...req, approvalRequired: true });
      ids.push(first.id);
      assert.equal(
        (await engine.execute(first.id, req.userId)).status,
        "waiting_approval",
      );
      assert.equal(s.memoryHeads(req.userId).length, 0);
      const approvalId = s.approval(first.id)!.approvalId;
      reopen();
      engine = rt([answer]);
      assert.equal(
        (
          await engine.execute(first.id, req.userId, {
            approvalId,
            decision: "approve",
          })
        ).status,
        "partial",
      );
      assert.equal(
        s.recallMemories(req.userId, "match", { query: "city" }).items[0]!
          .value,
        "成都",
      );
      reopen();
      engine = rt([
        plan("match"),
        call("memory_recall", { query: "city" }),
        call("knowledge_read", { id: "rule:match" }),
        call("jobs_search", {
          query: "Vue",
          categoryIds: ["frontend-junior", "frontend-mid"],
          limit: 10,
        }),
        call("jobs_check", {
          jobIds: ["synthetic-1-2"],
          observedSkills: ["Vue"],
        }),
        call("expert_finish", {
          status: "succeeded",
          summary: "本轮只推荐西安合格岗位",
          evidenceIds: ["job:synthetic-1-2", "rule:match"],
          unknowns: [],
          conflicts: [],
          nextActions: [],
          artifact: {
            rankedJobs: [
              {
                id: "synthetic-1-2",
                reason: "当前城市与经验条件满足",
                gaps: ["需补充其他技能证据"],
              },
            ],
          },
        }),
        answer,
      ]);
      const second = engine.create({
        ...req,
        request: "本轮临时只考虑西安，不修改已保存的城市偏好",
        constraints: { ...req.constraints, cities: ["西安"] },
      });
      ids.push(second.id);
      assert.equal(
        (await engine.execute(second.id, req.userId)).status,
        "succeeded",
      );
      const planner = JSON.parse(
        (s.modelCalls(second.id)[0]!.messages as any[])[1].content,
      );
      assert.equal(planner.availablePriorArtifacts.length, 1);
      assert.equal(
        planner.availablePriorArtifacts[0].reuse.policy,
        "resume-facts-v2",
      );
      assert(
        !JSON.stringify(planner.availablePriorArtifacts).includes(
          "OLD_GOAL_ADVICE",
        ),
      );
      const search = s
        .events(second.id)
        .find(
          (e) =>
            e.type === "tool.completed" &&
            (e.payload as any).name === "jobs_search",
        )!.payload as any;
      assert(
        search.result.eligible.every(
          (hit: any) =>
            data.jobs.find((j) => j.id === hit.jobId)!.city === "西安",
        ),
      );
      const mid = search.result.categoryCoverage.find(
        (row: any) => row.categoryId === "frontend-mid",
      );
      assert(
        mid.totalInSelectedCorpus > 0 &&
          mid.matchingCity > 0 &&
          mid.eligible === 0 &&
          mid.exclusionCounts.experience > 0,
      );
      const pending = rt([]).create({
        ...req,
        request: "旧快照待处理",
        constraints: { ...req.constraints, cities: ["西安"] },
      });
      s.changeMemory(req.userId, {
        operation: "correct",
        operationId: "city-correction",
        namespace: "shared",
        key: "city",
        expectedVersion: 1,
        value: "西安",
        reason: "用户确认长期偏好变更",
      });
      assert.equal(s.run(pending.id).status, "stale");
      reopen();
      engine = rt([
        plan("match"),
        call("memory_recall", { query: "city" }),
        need(),
        answer,
      ]);
      const third = engine.create({
        ...req,
        request: "复核已确认城市偏好",
        constraints: { ...req.constraints, cities: ["西安"] },
      });
      ids.push(third.id);
      assert.equal(
        (await engine.execute(third.id, req.userId)).status,
        "partial",
      );
      const p3 = JSON.parse(
        (s.modelCalls(third.id)[0]!.messages as any[])[1].content,
      );
      assert.equal(p3.availablePriorArtifacts.length, 0);
      const recalled = (
        s
          .events(third.id)
          .find(
            (e) =>
              e.type === "tool.completed" &&
              (e.payload as any).name === "memory_recall",
          )!.payload as any
      ).result.memories;
      assert.equal(recalled[0].value, "西安");
      assert.equal(recalled[0].version, 2);
      s.changeMemory(req.userId, {
        operation: "retract",
        operationId: "city-retract",
        namespace: "shared",
        key: "city",
        expectedVersion: 2,
        reason: "用户撤回长期偏好",
      });
      reopen();
      engine = rt([
        plan("match"),
        call("memory_recall", { query: "city", includeInactive: true }),
        need(),
        answer,
      ]);
      const fourth = engine.create({
        ...req,
        request: "我已撤回城市偏好，请检查版本",
        constraints: { ...req.constraints, cities: [] },
      });
      ids.push(fourth.id);
      assert.equal(
        (await engine.execute(fourth.id, req.userId)).status,
        "partial",
      );
      const tombstones = (
        s
          .events(fourth.id)
          .find(
            (e) =>
              e.type === "tool.completed" &&
              (e.payload as any).name === "memory_recall",
          )!.payload as any
      ).result;
      assert.equal(tombstones.memories[0].state, "retracted");
      assert.equal(tombstones.memories[0].value, "");
      assert.equal(tombstones.memories[0].evidence, undefined);
      assert.equal(tombstones.versions[0].version, 3);
      const other = rt([]).create({ ...req, userId: "different-user" });
      writeFileSync(
        resolve(dir, "story.json"),
        JSON.stringify(
          {
            scope: "engineering replay, not model quality",
            architecture,
            turns: ids,
            staleRun: pending.id,
            checkpointCount: s.db
              .prepare("SELECT count(*) AS n FROM checkpoints")
              .get()!.n,
          },
          null,
          2,
        ),
      );
      await backup(s.db, resolve(dir, "before-forget.sqlite"));
      s.forgetUser(req.userId);
      assert.equal(s.listRuns(req.userId).length, 0);
      assert.equal(s.memoryHistory(req.userId).length, 0);
      assert(s.run(other.id, "different-user"));
      for (const id of ids)
        assert.equal(
          Number(
            s.db
              .prepare(
                "SELECT count(*) AS n FROM checkpoints WHERE thread_id=? OR thread_id LIKE ?",
              )
              .get(id, id + "::%")!.n,
          ),
          0,
        );
    } finally {
      s.close();
    }
  });
}
