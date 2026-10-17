import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { Store } from "../src/storage.js";
import { Runtime } from "../src/runtime.js";
import { DomainTools } from "../src/tools.js";
import { Knowledge } from "../src/retrieval.js";
import { loadDataset } from "../src/data.js";
import { ROOT, hash } from "../src/config.js";
import { config } from "./test-config.js";
import { reviewToolObservations } from "../src/review-tool-observations.js";

async function setup() {
  const store = new Store(":memory:"),
    knowledge = new Knowledge(
      loadDataset(resolve(ROOT, "data/synthetic/dataset.json")),
    );
  const run = new Runtime(
    store,
    knowledge,
    {
      mode: "replay",
      model: "fixture",
      async complete() {
        throw Error("Unexpected model call");
      },
    },
    config(),
  ).create({
    userId: "u",
    conversationId: "c",
    request: "规划",
    resumeText: "独立完成TypeScript项目。",
  });
  const profile = new DomainTools(
    "profile",
    run,
    "profile",
    store,
    knowledge,
    [],
    new AbortController().signal,
  );
  await profile.invoke("input_read", { source: "resume" }, "read");
  const args = {
    observations: [
      {
        dimension: "professionalSkill",
        level: 2,
        confidence: 1,
        evidenceId: `input:${run.id}:resume`,
        quote: "独立完成TypeScript项目。",
        rationale: "行为观察",
        basis: "behavior",
      },
    ],
  };
  const score = await profile.invoke("profile_score", args, "score");
  const match = new DomainTools(
    "match",
    run,
    "match",
    store,
    knowledge,
    [],
    new AbortController().signal,
  );
  await match.invoke(
    "knowledge_read",
    { id: "job:synthetic-1-1", maxChars: 6000 },
    "job",
  );
  await match.invoke(
    "jobs_check",
    { jobIds: ["synthetic-1-1"], observedSkills: ["TypeScript"] },
    "check",
  );
  return { store, knowledge, run, profile, args, score };
}

test("real score and job checks export exact accepted inputs/results, retain computation scope and deduplicate cache replays", async () => {
  const f = await setup();
  try {
    await f.profile.invoke("profile_score", f.args, "score-replay");
    const result = reviewToolObservations(f.store.db, f.run, []);
    assert.equal(result.observations.length, 2);
    const score = result.observations.find((o) => o.tool === "profile_score")!;
    assert.deepEqual(score.arguments, f.args);
    assert.deepEqual(score.result, f.score);
    assert.equal(score.provenance.length, 2);
    assert.equal(score.provenance[1]!.replayed, true);
    assert.deepEqual(result.coverage.profile_score, {
      started: 2,
      completed: 2,
      failed: 0,
      incomplete: 0,
      distinctResults: 1,
    });
    assert.equal(score.scope.executionId, "profile");
    assert.equal(score.scope.currentArtifactAttempt, false);
    const checked = result.observations.find((o) => o.tool === "jobs_check")!;
    assert.deepEqual((checked.result as any).results[0].matchedSkills, [
      "TypeScript",
    ]);
    assert.equal((checked.result as any).results[0].overlap, 0.25);
    assert.equal(checked.scope.role, "match");
    await f.profile.invoke(
      "profile_score",
      { observations: [{ ...f.args.observations[0], level: 1 }] },
      "new-score",
    );
    const versions = reviewToolObservations(
      f.store.db,
      f.run,
      [],
    ).observations.filter((o) => o.tool === "profile_score");
    assert.equal(versions.length, 2);
    assert.deepEqual(
      versions.map((v) => v.scope.currentScoreReceipt),
      [false, true],
    );
  } finally {
    f.store.close();
  }
});

test("changed results, cache identities and missing scoring journals fail export instead of manufacturing tool evidence", async () => {
  const f = await setup();
  try {
    const record = reviewToolObservations(
      f.store.db,
      f.run,
      [],
    ).observations.find((o) => o.tool === "profile_score")!;
    const original = String(
      f.store.db
        .prepare("select result from tool_cache where run_id=? and key=?")
        .get(f.run.id, record.cacheKey)!.result,
    );
    f.store.db
      .prepare("update tool_cache set result=? where run_id=? and key=?")
      .run(
        JSON.stringify({
          ...(f.score as any),
          scores: { professionalSkill: 99 },
        }),
        f.run.id,
        record.cacheKey,
      );
    assert.throws(
      () => reviewToolObservations(f.store.db, f.run, []),
      /result\/cache mismatch/,
    );
    f.store.db
      .prepare("update tool_cache set result=? where run_id=? and key=?")
      .run(original, f.run.id, record.cacheKey);
    const event = f.store
      .events(f.run.id)
      .find(
        (e) =>
          e.type === "tool.completed" &&
          (e.payload as any).name === "profile_score",
      )!;
    f.store.db.prepare("update events set body=? where id=?").run(
      JSON.stringify({
        ...event,
        payload: { ...(event.payload as object), cacheKey: "wrong" },
      }),
      event.eventId,
    );
    assert.throws(
      () => reviewToolObservations(f.store.db, f.run, []),
      /identity mismatch/,
    );
    f.store.db
      .prepare("update events set body=? where id=?")
      .run(JSON.stringify(event), event.eventId);
    f.store.db
      .prepare(
        "delete from tool_cache where run_id=? and key like 'execution:%:profile-score:%'",
      )
      .run(f.run.id);
    assert.throws(
      () => reviewToolObservations(f.store.db, f.run, []),
      /durable receipt/,
    );
  } finally {
    f.store.close();
  }
});

test("a valid old scoring receipt cannot hide a corrupted latest pointer", async () => {
  const f = await setup();
  try {
    const original = reviewToolObservations(
      f.store.db,
      f.run,
      [],
    ).observations.find((o) => o.tool === "profile_score")!;
    const journalKey = "execution:profile:profile:profile-score:corrupt-last";
    for (const pointer of [
      { cacheKey: "missing", resultHash: original.resultHash },
      { cacheKey: original.cacheKey, resultHash: "wrong" },
      { cacheKey: "copied-score", resultHash: original.resultHash },
    ]) {
      f.store.putCache(f.run.id, "copied-score", original.result);
      f.store.db
        .prepare(
          "INSERT INTO tool_cache VALUES(?,?,?) ON CONFLICT(run_id,key) DO UPDATE SET result=excluded.result",
        )
        .run(f.run.id, journalKey, JSON.stringify(pointer));
      assert.throws(
        () => reviewToolObservations(f.store.db, f.run, []),
        /Current score receipt identity\/result mismatch/,
      );
    }
    f.store.db
      .prepare("delete from tool_cache where run_id=? and key=?")
      .run(f.run.id, journalKey);
    assert.equal(
      reviewToolObservations(f.store.db, f.run, []).observations.find(
        (o) => o.tool === "profile_score",
      )!.scope.currentScoreReceipt,
      true,
    );
  } finally {
    f.store.close();
  }
});

test("historical events require the original model-call execution snapshot; no guessed role or attempt is accepted", async () => {
  const f = await setup();
  try {
    const events = f.store
      .events(f.run.id)
      .filter((e) =>
        ["profile_score", "jobs_check"].includes(
          String((e.payload as any).name),
        ),
      );
    for (const event of events) {
      const { executionId, cacheKey: _, ...payload } = event.payload as any;
      f.store.db
        .prepare("update events set body=? where id=?")
        .run(JSON.stringify({ ...event, payload }), event.eventId);
      if (event.type === "tool.started") {
        const state = { runId: f.run.id, role: event.expert, executionId };
        const call = {
          role: event.expert,
          scope: `expert:${executionId}:turn:0`,
          executionState: state,
          executionStateHash: hash(state),
          response: {
            tool_calls: [
              {
                id: event.callId,
                function: {
                  name: payload.name,
                  arguments: JSON.stringify(payload.args),
                },
              },
            ],
          },
        };
        f.store.db
          .prepare("insert into model_calls values(?,?,?)")
          .run(event.callId, f.run.id, JSON.stringify(call));
      }
    }
    const result = reviewToolObservations(f.store.db, f.run, []);
    assert(
      result.observations.every(
        (o) => o.provenance[0]!.identity === "model-call",
      ),
    );
    f.store.db.prepare("delete from model_calls where id='score'").run();
    assert.throws(
      () => reviewToolObservations(f.store.db, f.run, []),
      /missing or ambiguous/,
    );
  } finally {
    f.store.close();
  }
});

test("failed calls and incomplete recovery prefixes remain visible but cannot become accepted observations", async () => {
  const f = await setup();
  try {
    await assert.rejects(
      f.profile.invoke(
        "profile_score",
        {
          observations: [{ ...f.args.observations[0], quote: "不存在的引文" }],
        },
        "bad",
      ),
      /quote mismatch/i,
    );
    const key = hash(["profile", "profile", "profile_score", f.args]);
    f.store.event(
      f.run.id,
      "tool.started",
      {
        name: "profile_score",
        args: f.args,
        executionId: "profile",
        cacheKey: key,
      },
      "profile",
      "recover",
    );
    await f.profile.invoke("profile_score", f.args, "recover");
    const result = reviewToolObservations(f.store.db, f.run, []);
    assert.deepEqual(result.coverage.profile_score, {
      started: 4,
      completed: 2,
      failed: 1,
      incomplete: 1,
      distinctResults: 1,
    });
    assert.equal(
      result.observations.filter((o) => o.tool === "profile_score").length,
      1,
    );
    assert(!JSON.stringify(result.observations).includes("不存在的引文"));
  } finally {
    f.store.close();
  }
});
