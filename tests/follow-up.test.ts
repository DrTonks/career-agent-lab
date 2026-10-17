import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { Store } from "../src/storage.js";
import { Runtime } from "../src/runtime.js";
import { Knowledge } from "../src/retrieval.js";
import { loadDataset } from "../src/data.js";
import { ROOT } from "../src/config.js";
import { ReplayProvider } from "../src/providers.js";
import {
  Dimensions,
  FollowUp,
  type ModelReply,
  type RunStatus,
} from "../src/contracts.js";
import { continuationContext, followUpInput } from "../src/follow-up.js";
import { config } from "./test-config.js";

const knowledge = new Knowledge(
  loadDataset(resolve(ROOT, "data/synthetic/dataset.json")),
);
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
const answer = {
  reply: {
    message: {
      role: "assistant" as const,
      content: "ASSISTANT_ASSERTION_DO_NOT_PROMOTE",
    },
    usage: { input: 10, output: 10, cachedInput: 0 },
    finishReason: "stop",
  },
};
const plan = call("plan_submit", {
  rationale: "仅画像",
  steps: [
    {
      id: "profile",
      expert: "profile",
      objective: "核验用户输入",
      dependsOn: [],
    },
  ],
});
const engine = (store: Store, replies: { reply: ModelReply }[] = []) =>
  new Runtime(store, knowledge, new ReplayProvider(replies), config());
const input = {
  userId: "follow-user",
  conversationId: "career",
  request: "仅画像，材料不足请追问",
  resumeText: "",
  constraints: { cities: ["成都"] },
};
const command = {
  operationId: "reply-1",
  reply: "本科应届，用Vue完成表单。暂无企业实习。",
};
const nullScores = () => Object.fromEntries(Dimensions.map((d) => [d, null]));
const need = call("expert_finish", {
  status: "needs_input",
  summary: "请补充经历",
  evidenceIds: [],
  unknowns: ["QUESTION_FROM_PROFILE：本人做过什么项目？"],
  conflicts: [],
  nextActions: [],
  artifact: { scores: nullScores(), skills: [], evidence: [] },
});

for (const architecture of ["multi-agent", "skills"] as const) {
  test(`${architecture}: explicit reply carries user evidence and scoped questions, not assistant claims or old artifacts`, async () => {
    const s = new Store(":memory:");
    try {
      let rt = engine(s, [plan, need, answer]);
      const parent = rt.create({ ...input, architecture });
      assert.equal(
        (await rt.execute(parent.id, input.userId)).status,
        "partial",
      );
      const parentSnapshot = JSON.stringify(s.run(parent.id));
      const child = rt.reply(parent.id, input.userId, command);
      assert.equal(child.inputVersion, 1);
      assert.equal(child.constraintVersion, parent.constraintVersion);
      assert(child.request.request.includes(command.reply));
      assert.equal(child.request.request, command.reply);
      assert.equal(child.continuation!.version, "user-reply-v2");
      assert(!child.request.request.includes("QUESTION_FROM_PROFILE"));
      assert(!child.request.request.includes("ASSISTANT_ASSERTION"));
      assert.equal(child.request.architecture, architecture);
      assert.equal(continuationContext(child, "profile")!.questions.length, 1);
      assert.equal(continuationContext(child, "match")!.questions.length, 0);
      const source = `input:${child.id}:request`;
      rt = engine(s, [
        plan,
        call("input_read", { source: "request", offset: 0, maxChars: 4000 }),
        call("resume_read", {}),
        call("clarification_update", {
          updates: [
            {
              questionId: continuationContext(child, "profile")!.questions[0]!
                .questionId,
              expectedVersion: 0,
              status: "answered",
              claims: [
                {
                  subject: "user",
                  text: "用Vue完成表单",
                  citations: [{ evidenceId: source, quote: "用Vue完成表单" }],
                },
              ],
              remaining: [],
              reason: "本轮已经回答本人项目内容",
            },
          ],
        }),
        call("profile_score", {
          observations: [
            {
              dimension: "professionalSkill",
              level: 1,
              confidence: 1,
              evidenceId: source,
              quote: "用Vue完成表单",
              rationale: "有课程技能使用",
              basis: "behavior",
            },
          ],
        }),
        call("expert_finish", {
          status: "partial",
          summary: "已补充项目证据",
          evidenceIds: [source],
          unknowns: ["学习过程未知"],
          conflicts: [],
          nextActions: [],
          artifact: {
            scores: { ...nullScores(), professionalSkill: 25 },
            skills: ["Vue"],
            evidence: [
              {
                dimension: "professionalSkill",
                evidenceId: source,
                quote: "用Vue完成表单",
              },
            ],
          },
        }),
        answer,
      ]);
      const result = await rt.execute(child.id, input.userId);
      assert.equal(result.status, "partial");
      assert.equal(
        (s.artifacts(child.id)[0]!.result.artifact.scores as any)
          .professionalSkill,
        25,
      );
      const planned = JSON.parse(
        (s.modelCalls(child.id)[0]!.messages as any[])[1].content,
      );
      assert.deepEqual(planned.availablePriorArtifacts, []);
      assert.equal(planned.continuation.parentRunId, parent.id);
      assert.equal(planned.continuation.questions.length, 1);
      assert.equal(
        s.events(child.id).filter((e) => e.type === "tool.failed").length,
        0,
      );
      assert.equal(JSON.stringify(s.run(parent.id)), parentSnapshot);
      const retry = rt.reply(parent.id, input.userId, command);
      assert.equal(retry.id, child.id);
      assert.equal(s.listRuns(input.userId).length, 2);
      assert.throws(
        () =>
          rt.reply(parent.id, input.userId, { ...command, reply: "不同内容" }),
        /already used/,
      );
      assert.throws(
        () =>
          rt.reply(parent.id, input.userId, { ...command, operationId: "new" }),
        /latest run/,
      );
      const third = rt.reply(child.id, input.userId, {
        operationId: "reply-2",
        reply: "改为西安，清空简历以便重填",
        resumeText: "",
        constraints: { cities: ["西安"] },
      });
      assert.equal(third.inputVersion, 2);
      assert.equal(third.constraintVersion, 2);
      assert.equal(third.request.resumeText, "");
      assert.equal(third.continuation!.resumeReplaced, true);
      const tampered = {
        ...third,
        continuation: { ...third.continuation!, reply: "forged" },
      };
      assert.throws(() => continuationContext(tampered), /snapshot changed/);
      assert.throws(
        () =>
          continuationContext({
            ...third,
            request: { ...third.request, request: "forged" },
          }),
        /snapshot changed/,
      );
    } finally {
      s.close();
    }
  });
}

test("reply contract distinguishes replacement from omission and accepts history beyond the per-message limit without identity injection", () => {
  const s = new Store(":memory:");
  try {
    const rt = engine(s),
      p = rt.create({
        ...input,
        resumeText: "原简历",
        request: "x".repeat(39995),
      });
    s.update(p.id, { status: "partial" });
    assert.throws(() => rt.reply(p.id, "another-user", command), /not owned/);
    assert.throws(() => FollowUp.parse({ ...command, userId: "evil" }));
    assert.throws(() => FollowUp.parse({ ...command, reply: "   " }));
    const c = rt.reply(p.id, input.userId, command);
    assert.equal(c.request.request, command.reply);
    assert.equal(s.inputVersion(input.userId, input.conversationId), 1);
    assert.equal(s.run(p.id).request.request.length, 39995);
    assert.equal(c.request.resumeText, "原简历");
    assert.deepEqual(c.request.constraints.cities, ["成都"]);
    s.update(c.id, { status: "partial" });
    const next = rt.reply(c.id, input.userId, {
      ...command,
      operationId: "clear",
      resumeText: "",
      constraints: {},
    });
    assert.equal(next.request.resumeText, "");
    assert.deepEqual(next.request.constraints.cities, []);
  } finally {
    s.close();
  }
});

test("reply refuses unfinished/cancelled parent and active lease before mutating any state", () => {
  const s = new Store(":memory:");
  try {
    const rt = engine(s),
      p = rt.create(input);
    for (const status of [
      "created",
      "running",
      "waiting_approval",
      "failed",
      "cancelled",
      "stale",
      "rejected",
    ] as RunStatus[]) {
      s.update(p.id, { status });
      assert.throws(
        () => rt.reply(p.id, input.userId, command),
        /completed parent/,
      );
    }
    s.update(p.id, { status: "partial" });
    s.lease(p.id, "owner", 5000);
    assert.throws(() => rt.reply(p.id, input.userId, command), /active lease/);
    s.release(p.id, "owner");
    assert.equal(s.inputVersion(input.userId, input.conversationId), 0);
  } finally {
    s.close();
  }
});

test("reply transaction rolls back child, revisions, command and events; committed observer errors are idempotently recoverable", () => {
  const s = new Store(":memory:");
  try {
    const rt = engine(s),
      p = rt.create(input);
    s.update(p.id, { status: "partial" });
    const seen: string[] = [];
    s.onEvent = (e) => seen.push(e.type);
    s.db.exec(
      "CREATE TEMP TRIGGER abort_follow_up BEFORE INSERT ON follow_up_commands BEGIN SELECT RAISE(ABORT,'injected rollback'); END",
    );
    const change = { ...command, constraints: { cities: ["西安"] } };
    assert.throws(
      () => rt.reply(p.id, input.userId, change),
      /injected rollback/,
    );
    assert.equal(s.listRuns(input.userId).length, 1);
    assert.equal(s.inputVersion(input.userId, input.conversationId), 0);
    assert.deepEqual(seen, []);
    assert.equal(
      s.advanceConstraints(
        input.userId,
        input.conversationId,
        p.request.constraints,
      ),
      1,
    );
    s.db.exec("DROP TRIGGER abort_follow_up");
    s.onEvent = () => {
      throw Error("observer disconnected");
    };
    assert.throws(
      () => rt.reply(p.id, input.userId, change),
      /observer disconnected/,
    );
    s.onEvent = undefined;
    const child = rt.reply(p.id, input.userId, change);
    assert.equal(child.constraintVersion, 2);
    assert.equal(child.inputVersion, 1);
    assert.equal(
      s.events(child.id).filter((e) => e.type === "run.continued").length,
      1,
    );
    assert.equal(s.listRuns(input.userId).length, 2);
  } finally {
    s.close();
  }
});

test("new reply invalidates late work, prevents later artifact resurrection, and forget removes command records", async () => {
  const s = new Store(":memory:");
  try {
    let rt = engine(s);
    const old = rt.create(input),
      parent = rt.create(input);
    s.update(parent.id, { status: "partial" });
    s.saveArtifact({
      id: "old-profile",
      runId: parent.id,
      stepId: "profile",
      expert: "profile",
      version: 1,
      result: {
        status: "succeeded",
        summary: "OBSOLETE_PROFILE_MUST_NOT_RETURN",
        evidenceIds: [],
        unknowns: [],
        conflicts: [],
        nextActions: [],
        artifact: { scores: nullScores(), skills: [], evidence: [] },
      },
    });
    const c = rt.reply(parent.id, input.userId, command);
    assert.throws(
      () =>
        s.saveArtifact({
          id: "late-profile",
          runId: old.id,
          stepId: "profile",
          expert: "profile",
          version: 1,
          result: {
            status: "needs_input",
            summary: "late",
            evidenceIds: [],
            unknowns: [],
            conflicts: [],
            nextActions: [],
            artifact: {},
          },
        }),
      /Conversation input changed/,
    );
    assert.equal(s.artifacts(old.id).length, 0);
    assert.throws(() => s.assertCurrent(old), /Conversation input changed/);
    assert.equal(s.run(old.id).status, "stale");
    s.update(c.id, { status: "partial" });
    rt = engine(s, [plan, need, answer]);
    const later = rt.create(input);
    assert.equal(later.inputVersion, 1);
    await rt.execute(later.id, input.userId);
    const planned = JSON.parse(
      (s.modelCalls(later.id)[0]!.messages as any[])[1].content,
    );
    assert.deepEqual(planned.availablePriorArtifacts, []);
    const other = rt.create({ ...input, userId: "other" });
    s.update(other.id, { status: "partial" });
    rt.reply(other.id, "other", command);
    s.forgetUser(input.userId);
    assert.equal(
      s.db
        .prepare("SELECT count(*) n FROM follow_up_commands WHERE user_id=?")
        .get(input.userId)!.n,
      0,
    );
    assert.equal(s.inputVersion(input.userId, input.conversationId), 0);
    assert.equal(s.listRuns("other").length, 2);
    assert.throws(
      () => rt.reply(parent.id, input.userId, command),
      /not owned/,
    );
  } finally {
    s.close();
  }
});

test("CLI reply executes once and repeated terminal submission returns the same persisted child", () => {
  mkdirSync(resolve(ROOT, "var/tests"), { recursive: true });
  const dir = mkdtempSync(resolve(ROOT, "var/tests/follow-up-cli-")),
    db = resolve(dir, "runs.sqlite");
  const requestFile = resolve(dir, "request.json"),
    replyFile = resolve(dir, "reply.json"),
    fixture = resolve(dir, "replay.json"),
    empty = resolve(dir, "empty.json");
  writeFileSync(requestFile, JSON.stringify(input));
  writeFileSync(replyFile, JSON.stringify(command));
  writeFileSync(fixture, JSON.stringify([plan, need, answer]));
  writeFileSync(empty, "[]");
  const cli = (args: string[]) => {
    const result = spawnSync(
      process.execPath,
      [resolve(ROOT, "dist/src/cli.js"), ...args, "--db", db],
      {
        encoding: "utf8",
        timeout: 20000,
        env: { ...process.env, CAREER_FINAL_REVIEW: "off" },
      },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const parent = cli(["run", "--case", requestFile, "--replay", fixture]).run;
  const inspect = cli(["inspect", "--run", parent.id, "--user", input.userId]);
  const prepared = followUpInput(
    parent,
    FollowUp.parse(command),
    inspect.artifacts,
  );
  const questionId = continuationContext({ ...parent, ...prepared }, "profile")!
    .questions[0]!.questionId;
  writeFileSync(
    fixture,
    JSON.stringify([
      plan,
      call("input_read", { source: "request", offset: 0, maxChars: 4000 }),
      call("resume_read", {}),
      call("clarification_update", {
        updates: [
          {
            questionId,
            expectedVersion: 0,
            status: "unanswered",
            claims: [],
            remaining: ["项目职责仍待进一步核验"],
            reason: "本协议回放仅验证续接与提交，不代表语义评价",
          },
        ],
      }),
      need,
      answer,
    ]),
  );
  const args = [
    "reply",
    "--run",
    parent.id,
    "--user",
    input.userId,
    "--case",
    replyFile,
  ];
  const first = cli([...args, "--replay", fixture]);
  const second = cli([...args, "--replay", empty]);
  assert.equal(second.run.id, first.run.id);
  assert.equal(second.reused, true);
  assert.equal(first.run.continuation.parentRunId, parent.id);
  const s = new Store(db);
  try {
    assert.equal(s.listRuns(input.userId).length, 2);
    assert.equal(s.modelCalls(first.run.id).length, 6);
  } finally {
    s.close();
  }
});

for (const boundary of ["before-commit", "after-commit"]) {
  test(`actual process kill ${boundary}: reply is atomic and retry creates only one child`, () => {
    mkdirSync(resolve(ROOT, "var/tests"), { recursive: true });
    const dir = mkdtempSync(resolve(ROOT, "var/tests/follow-up-")),
      db = resolve(dir, "runs.sqlite");
    let s = new Store(db);
    let rt = engine(s);
    const p = rt.create(input);
    s.update(p.id, { status: "partial" });
    s.close();
    const child = spawnSync(
      process.execPath,
      [
        resolve(ROOT, "dist/tests/fixtures/follow-up-worker.js"),
        db,
        p.id,
        input.userId,
        boundary,
      ],
      { encoding: "utf8", timeout: 20000 },
    );
    writeFileSync(
      resolve(dir, "process-result.json"),
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
    assert.notEqual(child.status, 0);
    assert(child.stdout.includes(boundary));
    s = new Store(db);
    try {
      rt = engine(s);
      assert.equal(
        s.listRuns(input.userId).length,
        boundary === "before-commit" ? 1 : 2,
      );
      const reply = rt.reply(p.id, input.userId, command),
        retry = rt.reply(p.id, input.userId, command);
      assert.equal(reply.id, retry.id);
      assert.equal(s.listRuns(input.userId).length, 2);
      assert.equal(reply.inputVersion, 1);
      assert.equal(
        s.events(reply.id).filter((e) => e.type === "run.continued").length,
        1,
      );
      assert.equal(
        s.db.prepare("PRAGMA integrity_check").get()!.integrity_check,
        "ok",
      );
    } finally {
      s.close();
    }
  });
}
