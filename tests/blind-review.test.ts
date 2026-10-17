import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, cpSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { setTimeout } from "node:timers/promises";
import { config, hash, ROOT } from "../src/config.js";
import {
  reviewSchedule,
  reviewRequest,
  validateBundle,
  validateJudgment,
} from "../src/blind-review.js";
import { prepareBlindMaterials } from "../src/blind-materials.js";
import { BlindRunner } from "../src/blind-runner.js";
import { Store } from "../src/storage.js";
import { Request } from "../src/contracts.js";
import { loadDataset } from "../src/data.js";
import { blindBundle, blindProvider } from "./fixtures/blind-provider.js";
const cfg = { ...config(), model: "blind-fixture", leaseTtlMs: 600 };
const root = resolve(ROOT, "var/tests");
mkdirSync(root, { recursive: true });
test("blind schedule reverses comparison positions and never injects provenance or other ratings", () => {
  const jobs = reviewSchedule(blindBundle);
  assert.equal(jobs.length, 6);
  assert.deepEqual(jobs, reviewSchedule(blindBundle));
  assert.deepEqual(jobs[4]!.labels, [...jobs[5]!.labels].reverse());
  for (const j of jobs) {
    const r = reviewRequest(blindBundle.cases[0]!, j);
    assert.equal(r.messages.length, 2);
    assert.equal(r.tools.length, 1);
    const user = JSON.parse(r.messages[1]!.content!);
    assert.equal(user.candidates.length, j.kind === "rating" ? 1 : 2);
    assert.deepEqual(Object.keys(user), ["rubric", "sources", "candidates"]);
  }
  const bad = structuredClone(blindBundle);
  bad.cases[0]!.sources[0]!.text = "changed";
  assert.throws(() => validateBundle(bad), /hash/);
});
test("judge validation rejects fabricated quotes, missing dimensions and other candidates", async () => {
  const c = blindBundle.cases[0]!,
    job = reviewSchedule(blindBundle)[0]!,
    request = reviewRequest(c, job);
  const reply = await blindProvider().complete(
    request.messages,
    request.tools,
    new AbortController().signal,
  );
  assert.ok(validateJudgment(c, job, reply));
  const mutate = (fn: (x: any) => void) => {
    const r = structuredClone(reply),
      v = JSON.parse(r.message.tool_calls![0]!.function.arguments);
    fn(v);
    r.message.tool_calls![0]!.function.arguments = JSON.stringify(v);
    return r;
  };
  assert.throws(
    () =>
      validateJudgment(
        c,
        job,
        mutate((v) => (v.dimensions[0].evidenceIds[0] = "伪造")),
      ),
    /Unknown evidence ID/,
  );
  assert.throws(
    () =>
      validateJudgment(
        c,
        job,
        mutate((v) => (v.dimensions[0].answerEvidenceIds = ["不存在"])),
      ),
    /Answer evidence ID mismatch/,
  );
  assert.throws(
    () =>
      validateJudgment(
        c,
        job,
        mutate((v) => (v.dimensions[0].dimension = v.dimensions[1].dimension)),
      ),
    /coverage/,
  );
  assert.throws(
    () =>
      validateJudgment(
        c,
        job,
        mutate((v) => (v.label = v.label === "A" ? "B" : "A")),
      ),
    /labels/,
  );
});
test("judge journal resumes received response without calls and detects identity changes", async () => {
  const runner = new BlindRunner(":memory:");
  let calls = 0;
  try {
    await assert.rejects(() =>
      runner.execute(
        blindBundle,
        blindProvider(() => calls++),
        cfg,
        {
          afterReply: () => {
            throw Error("simulated interruption");
          },
        },
      ),
    );
    assert.equal(runner.attempts()[0]!.status, "received");
    const done = await runner.execute(
      blindBundle,
      blindProvider(() => calls++),
      cfg,
    );
    assert.equal(done.valid, 6);
    assert.equal(calls, 6);
    await runner.execute(
      blindBundle,
      blindProvider(() => calls++),
      cfg,
    );
    assert.equal(calls, 6);
    assert.equal(
      runner.store.db.prepare("select count(*) as n from judge_frames").get()!
        .n,
      18,
    );
    await assert.rejects(
      () =>
        runner.execute(blindBundle, blindProvider(), {
          ...cfg,
          maxCalls: cfg.maxCalls + 1,
        }),
      /identity mismatch/,
    );
  } finally {
    runner.close();
  }
});
test("judge keeps invalid replies, allows only bounded explicit retry and marks oversized materials unassessed", async () => {
  const runner = new BlindRunner(":memory:");
  let calls = 0;
  const bad = blindProvider(() => calls++);
  const original = bad.complete;
  bad.complete = async (...args) => {
    const r = await original(...args);
    r.message.tool_calls![0]!.function.arguments = "{";
    return r;
  };
  try {
    await runner.execute(blindBundle, bad, cfg);
    assert.equal(calls, 6);
    await runner.execute(blindBundle, bad, cfg);
    assert.equal(calls, 6);
    await runner.execute(blindBundle, bad, cfg, { retryFailed: true });
    assert.equal(calls, 12);
    await runner.execute(blindBundle, bad, cfg, { retryFailed: true });
    assert.equal(calls, 12);
    assert.equal(runner.attempts().length, 12);
  } finally {
    runner.close();
  }
  const small = new BlindRunner(":memory:");
  try {
    const result = await small.execute(
      blindBundle,
      blindProvider(() => {
        throw Error("must not call");
      }),
      { ...cfg, maxContextTokens: 1 },
    );
    assert.equal(result.valid, 0);
    assert.ok(result.rows.every((r) => r.result?.status === "unassessed"));
  } finally {
    small.close();
  }
});
test("material export binds original task/answers and includes complete common sources without architecture metadata", () => {
  const dir = mkdtempSync(resolve(root, "blind-materials-"));
  mkdirSync(resolve(dir, "snapshot"));
  cpSync(
    resolve(ROOT, "data/synthetic/dataset.json"),
    resolve(dir, "snapshot/dataset.json"),
  );
  cpSync(resolve(ROOT, "knowledge"), resolve(dir, "snapshot/knowledge"), {
    recursive: true,
  });
  mkdirSync(resolve(dir, "snapshot/src"));
  for (const file of ["tools.ts", "retrieval.ts"])
    cpSync(resolve(ROOT, "src", file), resolve(dir, "snapshot/src", file));
  const data = loadDataset(resolve(dir, "snapshot/dataset.json")),
    request = Request.parse({
      userId: "u",
      conversationId: "c",
      request: "task",
      resumeText: "resume",
    });
  writeFileSync(
    resolve(dir, "snapshot/suite.json"),
    JSON.stringify({
      split: "development",
      cases: [{ id: "c", input: request }],
    }),
  );
  const store = new Store(resolve(dir, "runs.sqlite"));
  const rows = (["multi-agent", "skills"] as const).map((architecture, i) => {
    const id = `run-${i}`;
    store.createRun({
      id,
      request: { ...request, userId: id, architecture },
      status: "partial",
      mode: "live",
      datasetVersion: data.version,
      configHash: "test",
      constraintVersion: 1,
      createdAt: "",
      updatedAt: "",
      answer: `answer-${i}`,
    });
    return {
      caseId: "c",
      repeat: 0,
      runId: id,
      architecture,
      mode: "live",
      answer: `answer-${i}`,
    };
  });
  writeFileSync(resolve(dir, "records.json"), JSON.stringify(rows));
  try {
    const result = prepareBlindMaterials(dir, 33);
    assert.equal(result.bundle.cases.length, 1);
    assert.equal(result.mapping.length, 2);
    assert.ok(
      result.bundle.cases[0]!.sources.some(
        (s) => s.id === `job:${data.jobs.at(-1)!.id}`,
      ),
    );
    assert.ok(!JSON.stringify(result.bundle).includes("multi-agent"));
    assert.ok(!JSON.stringify(result.bundle).includes("run-0"));
    assert.deepEqual(result, prepareBlindMaterials(dir, 33));
    rows[0]!.answer = "tampered";
    writeFileSync(resolve(dir, "records.json"), JSON.stringify(rows));
    assert.throws(() => prepareBlindMaterials(dir, 33), /provenance/);
    rows[0]!.answer = "answer-0";
    writeFileSync(resolve(dir, "records.json"), JSON.stringify(rows));
    store.update("run-0", { memorySnapshot: hash(["memory"]) });
    assert.throws(() => prepareBlindMaterials(dir, 33), /dedicated exporter/);
    store.update("run-0", {
      memorySnapshot: hash([]),
      status: "failed",
      answer: undefined,
    });
    rows[0]!.answer = "";
    writeFileSync(resolve(dir, "records.json"), JSON.stringify(rows));
    assert.ok(
      prepareBlindMaterials(dir, 33).bundle.cases[0]!.candidates.some(
        (c) => c.text === "",
      ),
    );
  } finally {
    store.close();
  }
});
test("bound answer spans preserve full long Unicode answer and reject another candidate's spans", async () => {
  const bundle = structuredClone(blindBundle),
    c = bundle.cases[0]!;
  c.candidates[0]!.text = "长文🙂。".repeat(220);
  const job = reviewSchedule(bundle).find(
      (j) => j.kind === "rating" && j.labels[0] === "A",
    )!,
    request = reviewRequest(c, job);
  const fragments = JSON.parse(request.messages[1]!.content!).candidates[0]
    .fragments;
  let covered = 0;
  for (const f of fragments) {
    assert.ok(f.start <= covered);
    assert.equal(f.text, c.candidates[0]!.text.slice(f.start, f.end));
    covered = f.end;
  }
  assert.equal(covered, c.candidates[0]!.text.length);
  const other = reviewRequest(c, { ...job, labels: ["B"] });
  const reply = await blindProvider().complete(
    other.messages,
    other.tools,
    new AbortController().signal,
  );
  const payload = JSON.parse(reply.message.tool_calls![0]!.function.arguments);
  payload.label = "A";
  reply.message.tool_calls![0]!.function.arguments = JSON.stringify(payload);
  assert.throws(
    () => validateJudgment(c, job, reply),
    /Answer evidence ID mismatch/,
  );
});
test("judge concurrent lease, cancellation and cumulative limits fail closed", async () => {
  const dir = mkdtempSync(resolve(root, "blind-lock-")),
    path = resolve(dir, "judge.sqlite"),
    a = new BlindRunner(path),
    b = new BlindRunner(path);
  let release!: () => void, entered!: () => void;
  const inside = new Promise<void>((r) => (entered = r)),
    wait = new Promise<void>((r) => (release = r));
  const provider = blindProvider(),
    base = provider.complete;
  provider.complete = async (...args) => {
    entered();
    await wait;
    return base(...args);
  };
  const stop = new AbortController();
  try {
    const pending = a.execute(blindBundle, provider, cfg, {
      signal: stop.signal,
    });
    await inside;
    await assert.rejects(
      () => b.execute(blindBundle, blindProvider(), cfg),
      /already executing/,
    );
    stop.abort();
    release();
    await assert.rejects(() => pending, /cancelled/);
    assert.equal(a.attempts().length, 1);
    assert.equal(a.attempts()[0]!.status, "failed");
  } finally {
    a.close();
    b.close();
  }
  const limited = new BlindRunner(":memory:");
  let calls = 0;
  try {
    const done = await limited.execute(
      blindBundle,
      blindProvider(() => calls++),
      { ...cfg, maxCalls: 2 },
    );
    assert.equal(calls, 2);
    assert.equal(done.valid, 2);
    assert.equal(
      done.rows.filter((r) => r.result?.status === "unassessed").length,
      4,
    );
  } finally {
    limited.close();
  }
});
for (const boundary of ["response", "stream", "partial"]) {
  test(`judge real process termination at ${boundary} preserves responses and unknown outcomes`, async () => {
    const dir = mkdtempSync(resolve(root, `blind-recovery-${boundary}-`)),
      path = resolve(dir, "judge.sqlite");
    const child = spawnSync(
      process.execPath,
      [resolve(ROOT, "dist/tests/fixtures/blind-worker.js"), path, boundary],
      { timeout: 20000, encoding: "utf8", windowsHide: true },
    );
    assert.equal(child.error, undefined);
    assert.notEqual(child.status, 0);
    assert.ok(!child.stderr.includes("Expected termination boundary"));
    await setTimeout(700);
    const runner = new BlindRunner(path);
    let calls = 0;
    try {
      const before = runner.attempts();
      assert.equal(before.length, 1);
      assert.equal(
        before[0]!.status,
        boundary === "response" ? "received" : "started",
      );
      const result = await runner.execute(
        blindBundle,
        blindProvider(() => calls++),
        cfg,
      );
      assert.equal(calls, 5);
      assert.equal(result.valid, boundary === "partial" ? 5 : 6);
      if (boundary === "partial") {
        assert.equal(runner.attempts()[0]!.status, "interrupted");
        await runner.execute(
          blindBundle,
          blindProvider(() => calls++),
          cfg,
          { retryFailed: true },
        );
        assert.equal(calls, 6);
        assert.equal(runner.attempts().length, 7);
      }
    } finally {
      runner.close();
    }
  });
}
