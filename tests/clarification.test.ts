import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { Store } from "../src/storage.js";
import { Runtime } from "../src/runtime.js";
import { Knowledge } from "../src/retrieval.js";
import { loadDataset } from "../src/data.js";
import { ROOT } from "../src/config.js";
import { ReplayProvider } from "../src/providers.js";
import { DomainTools } from "../src/tools.js";
import { Clarifications } from "../src/clarification.js";
import { continuationContext } from "../src/follow-up.js";
import type { ExpertResult, RunRecord } from "../src/contracts.js";
import { config } from "./test-config.js";
const k = new Knowledge(
  loadDataset(resolve(ROOT, "data/synthetic/dataset.json")),
);
function setup(
  db = ":memory:",
  request = "补充教育信息",
  resume = "本科计算机专业，应届毕业生。",
  reply = "见补充简历，请更新画像",
) {
  const store = new Store(db),
    rt = new Runtime(store, k, new ReplayProvider([]), config());
  const parent = rt.create({
    userId: "clarify-user",
    conversationId: "c",
    request,
  });
  store.saveArtifact({
    id: `${parent.id}:profile`,
    runId: parent.id,
    stepId: "profile",
    expert: "profile",
    version: 1,
    result: {
      status: "needs_input",
      summary: "需补充资料",
      evidenceIds: [],
      unknowns: ["教育背景：学校、专业、学历、毕业时间？", "证书是否已取得？"],
      conflicts: [],
      nextActions: [],
      artifact: {},
    },
  });
  store.saveArtifact({
    id: `${parent.id}:match`,
    runId: parent.id,
    stepId: "match",
    expert: "match",
    version: 1,
    result: {
      status: "needs_input",
      summary: "需确认城市",
      evidenceIds: [],
      unknowns: ["希望在哪个城市工作？"],
      conflicts: [],
      nextActions: [],
      artifact: {},
    },
  });
  store.update(parent.id, { status: "partial" });
  const run = rt.reply(parent.id, "clarify-user", {
    operationId: "reply",
    reply,
    resumeText: resume,
  });
  const tools = new DomainTools(
    "profile",
    run,
    "profile",
    store,
    k,
    [],
    new AbortController().signal,
  );
  const q = continuationContext(run, "profile")!.questions;
  return { store, rt, run, tools, q };
}
async function readInputs(t: DomainTools) {
  await t.invoke("input_read", { source: "request" }, "request");
  await t.invoke("resume_read", {}, "resume");
}
const update = (questionId: string) => ({
  questionId,
  expectedVersion: 0,
  status: "partial",
  claims: [
    {
      subject: "user",
      text: "学历本科，专业计算机，应届毕业生",
      citations: [
        { evidenceId: "resume:1", quote: "本科计算机专业，应届毕业生。" },
      ],
    },
  ],
  remaining: ["学校名称", "毕业年月"],
  reason: "复合问题只解决了明确给出的字段",
});
const unanswered = (questionId: string) => ({
  questionId,
  expectedVersion: 0,
  status: "unanswered",
  claims: [],
  remaining: ["证书名称与取得状态"],
  reason: "本次未找到可核验信息，继续询问",
});
const finish = (): ExpertResult => ({
  status: "needs_input",
  summary: "教育已部分确认",
  evidenceIds: [],
  unknowns: ["教育背景：学校、专业、学历、毕业时间？"],
  conflicts: [],
  nextActions: [],
  artifact: {},
});

test("compound clarification retains answered fields, narrows unknowns and publishes actual primary evidence", async () => {
  const { store, tools, q } = setup();
  try {
    await assert.rejects(
      tools.invoke("expert_finish", finish(), "early"),
      /clarification_required/,
    );
    await readInputs(tools);
    const result = (await tools.invoke(
      "clarification_update",
      { updates: [update(q[0]!.questionId), unanswered(q[1]!.questionId)] },
      "resolve",
    )) as any;
    assert.equal(result.current.length, 2);
    assert.equal(result.current[0].version, 1);
    await tools.invoke("expert_finish", finish(), "finish");
    assert.deepEqual(tools.result!.unknowns, [
      "学校名称",
      "毕业年月",
      "证书名称与取得状态",
    ]);
    assert.deepEqual(tools.result!.evidenceIds, ["resume:1"]);
    assert.equal(
      (tools.result!.artifact.clarifications as any[])[0].claims[0].text,
      "学历本科，专业计算机，应届毕业生",
    );
  } finally {
    store.close();
  }
});

test("actual read ranges reject missing middle pages even when text repeats; empty input still needs a read", async () => {
  const { store, tools, q, run } = setup(
    ":memory:",
    "历史目标",
    "",
    "甲".repeat(1100),
  );
  try {
    await tools.invoke(
      "input_read",
      { source: "request", offset: 0, maxChars: 200 },
      "first",
    );
    await tools.invoke(
      "input_read",
      {
        source: "request",
        offset: run.request.request.length - 200,
        maxChars: 200,
      },
      "last",
    );
    await assert.rejects(
      tools.invoke(
        "clarification_update",
        { updates: [unanswered(q[0]!.questionId)] },
        "gap",
      ),
      /input_incomplete/,
    );
    const before = (await tools.invoke(
      "clarification_update",
      { updates: [] },
      "inspect",
    )) as any;
    assert.equal(before.coverage.request.nextOffset, 200);
    assert.equal(before.coverage.resume.complete, false);
    await readInputs(tools);
    await tools.invoke(
      "clarification_update",
      { updates: [unanswered(q[0]!.questionId)] },
      "complete",
    );
  } finally {
    store.close();
  }
});

test("foreign questions, duplicates, model-only/unread/mismatched citations and malformed states never mutate ledger", async () => {
  const { store, tools, q, run } = setup();
  try {
    await readInputs(tools);
    await tools.invoke("knowledge_read", { id: "rule:profile" }, "rule");
    const good = update(q[0]!.questionId),
      foreign = continuationContext(run, "match")!.questions[0]!.questionId;
    for (const updates of [
      [{ ...good, questionId: foreign }],
      [good, good],
      [
        {
          ...good,
          claims: [
            {
              ...good.claims[0],
              citations: [{ evidenceId: "rule:profile", quote: "画像" }],
            },
          ],
        },
      ],
      [
        {
          ...good,
          claims: [
            {
              ...good.claims[0],
              citations: [{ evidenceId: "resume:999", quote: "本科" }],
            },
          ],
        },
      ],
      [
        {
          ...good,
          claims: [
            {
              ...good.claims[0],
              citations: [{ evidenceId: "resume:1", quote: "博士" }],
            },
          ],
        },
      ],
      [{ ...good, status: "answered", remaining: ["学校"] }],
      [{ ...good, status: "partial", remaining: [] }],
      [{ ...good, status: "conflict" }],
      [{ ...good, status: "unanswered" }],
      [{ ...good, remaining: [q[0]!.text] }],
    ]) {
      await assert.rejects(
        tools.invoke("clarification_update", { updates }, "invalid"),
      );
      assert.equal(
        new Clarifications(store, run, "profile", "profile").current().length,
        0,
      );
    }
    // An invalid second item rolls back the entire proposed batch.
    await assert.rejects(
      tools.invoke(
        "clarification_update",
        {
          updates: [
            good,
            { ...unanswered(q[1]!.questionId), expectedVersion: 9 },
          ],
        },
        "atomic",
      ),
      /version_conflict/,
    );
    assert.equal(
      new Clarifications(store, run, "profile", "profile").current().length,
      0,
    );
  } finally {
    store.close();
  }
});

test("versioned corrections and old command retries never restore an outdated answer; attempt state stays isolated", async () => {
  const { store, tools, q, run } = setup();
  try {
    await readInputs(tools);
    const first = { updates: [update(q[0]!.questionId)] };
    await tools.invoke("clarification_update", first, "v1");
    const revised = {
      ...update(q[0]!.questionId),
      expectedVersion: 1,
      claims: [
        {
          ...update(q[0]!.questionId).claims[0]!,
          text: "仅核验学历为本科、专业为计算机，应届身份已声明",
        },
      ],
    };
    await tools.invoke("clarification_update", { updates: [revised] }, "v2");
    const retry = (await tools.invoke(
      "clarification_update",
      first,
      "retry",
    )) as any;
    assert.equal(retry.replayed, true);
    assert.equal(retry.current[0].version, 2);
    assert.equal(retry.current[0].claims[0].text, revised.claims[0]!.text);
    assert.equal(
      store.events(run.id).filter((e) => e.type === "clarification.updated")
        .length,
      2,
    );
    assert.equal(
      new Clarifications(store, run, "profile@2", "profile").current().length,
      0,
    );
    const restored = new DomainTools(
      "profile",
      run,
      "profile",
      store,
      k,
      [],
      new AbortController().signal,
    );
    await readInputs(restored);
    await restored.invoke(
      "clarification_update",
      { updates: [unanswered(q[1]!.questionId)] },
      "second",
    );
    await restored.invoke("expert_finish", finish(), "finish");
    assert.equal(
      (restored.result!.artifact.clarifications as any[])[0].version,
      2,
    );
  } finally {
    store.close();
  }
});

test("tampered read receipts and resolution records fail closed on reconstruction", async () => {
  const { store, tools, q, run } = setup();
  try {
    await readInputs(tools);
    await tools.invoke(
      "clarification_update",
      { updates: [update(q[0]!.questionId)] },
      "v1",
    );
    const entry = store.cacheEntries(
      run.id,
      "clarification:profile:profile:state:",
    )[0]!;
    const original = JSON.stringify(entry.value),
      bad = JSON.parse(original);
    bad.record.claims[0].text = "forged";
    store.db
      .prepare("UPDATE tool_cache SET result=? WHERE run_id=? AND key=?")
      .run(JSON.stringify(bad), run.id, entry.key);
    assert.throws(
      () => new Clarifications(store, run, "profile", "profile").current(),
      /hash_mismatch/,
    );
    store.db
      .prepare("UPDATE tool_cache SET result=? WHERE run_id=? AND key=?")
      .run(original, run.id, entry.key);
    const read = store.cacheEntries(
      run.id,
      "clarification:profile:profile:read:",
    )[0]!;
    const corrupt = { ...(read.value as any), resultHash: "wrong" };
    store.db
      .prepare("UPDATE tool_cache SET result=? WHERE run_id=? AND key=?")
      .run(JSON.stringify(corrupt), run.id, read.key);
    assert.throws(
      () => new Clarifications(store, run, "profile", "profile").coverage(),
      /receipt_mismatch/,
    );
  } finally {
    store.close();
  }
});

for (const boundary of ["before-commit", "after-commit"]) {
  test(`clarification actual process kill ${boundary} recovers one revision and the input read ledger`, () => {
    mkdirSync(resolve(ROOT, "var/tests"), { recursive: true });
    const dir = mkdtempSync(resolve(ROOT, "var/tests/clarification-")),
      db = resolve(dir, "runs.sqlite");
    const { store, run, q } = setup(db);
    store.close();
    const argsFile = resolve(dir, "update.json");
    writeFileSync(
      argsFile,
      JSON.stringify({ updates: [update(q[0]!.questionId)] }),
    );
    const child = spawnSync(
      process.execPath,
      [
        resolve(ROOT, "dist/tests/fixtures/clarification-worker.js"),
        db,
        run.id,
        boundary,
        argsFile,
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
    assert(child.stdout.includes(boundary), child.stderr);
    const s = new Store(db);
    try {
      const ledger = new Clarifications(s, s.run(run.id), "profile", "profile");
      assert.equal(
        ledger.current().length,
        boundary === "before-commit" ? 0 : 1,
      );
      assert(
        ledger.coverage().request.complete && ledger.coverage().resume.complete,
      );
    } finally {
      s.close();
    }
    const recovery = spawnSync(
      process.execPath,
      [
        resolve(ROOT, "dist/tests/fixtures/clarification-worker.js"),
        db,
        run.id,
        "recover",
        argsFile,
      ],
      { encoding: "utf8", timeout: 20000 },
    );
    assert.equal(recovery.error, undefined);
    assert.equal(recovery.status, 0, recovery.stderr);
    const again = new Store(db);
    try {
      assert.equal(
        new Clarifications(
          again,
          again.run(run.id),
          "profile",
          "profile",
        ).current()[0]!.version,
        1,
      );
      assert.equal(
        again.events(run.id).filter((e) => e.type === "clarification.updated")
          .length,
        1,
      );
    } finally {
      again.close();
    }
  });
}
