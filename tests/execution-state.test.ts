import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { ROOT, hash, estimateTokens } from "../src/config.js";
import {
  Runtime,
  compactMessages,
  EXECUTION_STATE_PREFIX,
} from "../src/runtime.js";
import { DomainTools, DomainValidationError } from "../src/tools.js";
import { Store } from "../src/storage.js";
import { Knowledge } from "../src/retrieval.js";
import { loadDataset } from "../src/data.js";
import { ReplayProvider } from "../src/providers.js";
import type { Message } from "../src/contracts.js";
import { config } from "./test-config.js";

const knowledge = new Knowledge(
  loadDataset(resolve(ROOT, "data/synthetic/dataset.json")),
);
function setup(
  db = ":memory:",
  architecture: "multi-agent" | "skills" = "multi-agent",
) {
  const store = new Store(db),
    rt = new Runtime(store, knowledge, new ReplayProvider([]), config());
  const parent = rt.create({
    userId: "u",
    conversationId: "state",
    request: "画像",
    architecture,
  });
  for (const role of ["profile", "match"] as const)
    store.saveArtifact({
      id: `${parent.id}:${role}`,
      runId: parent.id,
      stepId: role,
      expert: role,
      version: 1,
      result: {
        status: "needs_input",
        summary: "待补充",
        evidenceIds: [],
        unknowns:
          role === "profile"
            ? Array.from(
                { length: 30 },
                (_, i) => `教育经历问题${i}：学校、专业和毕业时间？`,
              )
            : ["仅匹配专家可见的问题"],
        conflicts: [],
        nextActions: [],
        artifact: {},
      },
    });
  store.update(parent.id, { status: "partial" });
  const run = rt.reply(parent.id, "u", {
    operationId: "r",
    reply: "补充教育信息",
    resumeText: "本科计算机专业，应届毕业生。",
  });
  const make = (id = "profile", role: "profile" | "match" = "profile") =>
    new DomainTools(
      role,
      run,
      id,
      store,
      knowledge,
      [],
      new AbortController().signal,
      { stepId: role, attempt: id.includes("@") ? 2 : 1, directory: [] },
    );
  return { store, run, make, tools: make() };
}
const partial = (questionId: string) => ({
  questionId,
  expectedVersion: 0,
  status: "partial",
  claims: [
    {
      subject: "user",
      text: "本科计算机专业",
      citations: [{ evidenceId: "resume:1", quote: "本科计算机专业" }],
    },
  ],
  remaining: ["学校名称", "毕业年月"],
  reason: "本次只回答部分教育信息",
});

test("execution view reconstructs accepted state without inheriting foreign roles, attempts, untrusted scores or read authority", async () => {
  const { store, tools, make } = setup();
  try {
    const initial = tools.executionState();
    assert.equal(initial.questions.length, 30);
    assert(
      initial.questions.every(
        (q) => q.version === 0 && q.status === "unreviewed",
      ),
    );
    assert(!JSON.stringify(initial).includes("仅匹配专家"));
    await tools.invoke("input_read", { source: "request" }, "request");
    await tools.invoke("resume_read", {}, "resume");
    await tools.invoke(
      "clarification_update",
      { updates: [partial(initial.questions[0]!.questionId)] },
      "partial",
    );
    const scored = (await tools.invoke(
      "profile_score",
      {
        observations: [
          {
            dimension: "professionalSkill",
            level: 2,
            confidence: 1,
            evidenceId: "resume:1",
            quote: "本科计算机专业",
            rationale: "测试评分回执",
          },
        ],
      },
      "score",
    )) as any;
    const restored = make(),
      state = restored.executionState();
    assert.equal(restored.seen.size, 0); // state reads do not grant source reads
    assert.equal(state.questions[0]!.version, 1);
    assert.deepEqual(state.questions[0]!.remaining, ["学校名称", "毕业年月"]);
    assert.equal(state.questions[0]!.claimCount, 1);
    assert.equal(state.scoring!.resultHash, hash(scored));
    assert.equal(state.scoring!.scores.professionalSkill, 50);
    assert.equal(state.inputCoverage.resume.complete, true);
    restored.remember({
      scoringVersion: scored.scoringVersion,
      scores: { professionalSkill: 100 },
    });
    assert.equal(
      restored.executionState().scoring!.scores.professionalSkill,
      50,
    );
    await restored.invoke("profile_score", { observations: [] }, "rescore");
    assert.equal(
      make().executionState().scoring!.scores.professionalSkill,
      null,
    );
    const retry = make("profile@2").executionState();
    assert.equal(retry.attempt, 2);
    assert.equal(retry.scoring, null);
    assert(retry.questions.every((q) => q.version === 0));
    assert.equal(retry.inputCoverage.resume.complete, false);
    const other = make("match", "match").executionState();
    assert.equal(other.questions.length, 1);
    assert.equal(other.scoring, null);
    await assert.rejects(
      tools.invoke(
        "clarification_update",
        {
          updates: [
            {
              ...partial(initial.questions[0]!.questionId),
              reason: "过期的新命令",
            },
          ],
        },
        "stale",
      ),
      /version_conflict/,
    );
    assert.equal(make().executionState().questions[0]!.version, 1);
  } finally {
    store.close();
  }
});

test("profile quote feedback locates the exact failing field while accepted clarification state remains intact", async () => {
  const { store, tools } = setup();
  try {
    await tools.invoke("input_read", { source: "request" }, "request");
    await tools.invoke("resume_read", {}, "resume");
    const q = tools.executionState().questions[0]!;
    await tools.invoke(
      "clarification_update",
      { updates: [partial(q.questionId)] },
      "partial",
    );
    await assert.rejects(
      tools.invoke(
        "profile_score",
        {
          observations: [
            {
              dimension: "professionalSkill",
              level: 2,
              confidence: 1,
              evidenceId: "resume:1",
              quote: "虚构句子",
              rationale: "错误引文测试",
            },
          ],
        },
        "invalid",
      ),
      (e: unknown) => {
        assert(e instanceof DomainValidationError);
        assert.equal(e.feedback.field, "observations[0].quote");
        assert.equal(e.feedback.evidenceId, "resume:1");
        assert.equal((e.feedback.read as any).access, "readable");
        return true;
      },
    );
    assert.equal(tools.executionState().questions[0]!.version, 1);
    assert.equal(tools.executionState().scoring, null);
  } finally {
    store.close();
  }
});

for (const architecture of ["multi-agent", "skills"] as const) {
  test(`${architecture}: repeated compaction pins all current question versions without conflating them with evidence`, () => {
    const { store, tools } = setup(":memory:", architecture);
    try {
      const state = tools.executionState();
      const control: Message = {
        role: "user",
        content:
          EXECUTION_STATE_PREFIX +
          JSON.stringify({ stateHash: hash(state), ...state }),
      };
      let messages: Message[] = [
        { role: "system", content: architecture },
        { role: "user", content: "TASK_DATA current profile" },
        control,
      ];
      const allowance = estimateTokens(JSON.stringify(messages)) + 2200;
      for (let i = 0; i < 8; i++) {
        messages.push(
          { role: "assistant", content: "历史分析".repeat(4000) },
          { role: "user", content: `工具后续反馈${i}` },
        );
        const compacted = compactMessages(messages, allowance);
        assert(compacted.removed > 0);
        messages = compacted.messages;
        assert.deepEqual(
          messages.filter((m) => m.content?.startsWith(EXECUTION_STATE_PREFIX)),
          [control],
        );
      }
    } finally {
      store.close();
    }
  });

  test(`${architecture}: actual process loss after durable response and state advance recovers the original call snapshot`, () => {
    mkdirSync(resolve(ROOT, "var/tests"), { recursive: true });
    const dir = mkdtempSync(resolve(ROOT, "var/tests/execution-state-")),
      db = resolve(dir, "runs.sqlite");
    const { store, run } = setup(db, architecture);
    store.close();
    for (const mode of ["crash", "recover"]) {
      const child = spawnSync(
        process.execPath,
        [
          resolve(ROOT, "dist/tests/fixtures/execution-state-worker.js"),
          db,
          run.id,
          mode,
        ],
        { encoding: "utf8", timeout: 20000, windowsHide: true },
      );
      writeFileSync(
        resolve(dir, `${mode}.json`),
        JSON.stringify(
          {
            status: child.status,
            signal: child.signal,
            stdout: child.stdout,
            stderr: child.stderr,
            error: child.error?.message,
          },
          null,
          2,
        ),
      );
      assert.equal(child.error, undefined);
      if (mode === "crash") {
        assert.notEqual(child.status, 0);
        assert.match(child.stdout, /STATE_ADVANCED/);
      } else assert.equal(child.status, 0, child.stderr);
    }
    const restored = new Store(db);
    try {
      const calls = restored.modelCalls(run.id);
      assert.equal(calls.length, 1);
      const old = calls[0]!.executionState as ReturnType<
        DomainTools["executionState"]
      >;
      assert.equal(old.questions[0]!.version, 0);
      assert.equal(calls[0]!.executionStateHash, hash(old));
      const now = new DomainTools(
        "profile",
        restored.run(run.id),
        "profile",
        restored,
        knowledge,
        [],
        new AbortController().signal,
      ).executionState();
      assert.equal(now.questions[0]!.version, 1);
      assert.equal(
        restored.events(run.id).filter((e) => e.type === "model.recovered")
          .length,
        1,
      );
    } finally {
      restored.close();
    }
  });
}
