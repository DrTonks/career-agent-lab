import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { Store } from "../src/storage.js";
import { Runtime } from "../src/runtime.js";
import { Knowledge } from "../src/retrieval.js";
import { loadDataset } from "../src/data.js";
import { ROOT, config } from "../src/config.js";
import { Request } from "../src/contracts.js";
import { finalFacts, inspectFinal } from "../src/final-review.js";
import { reviewProvider } from "./fixtures/final-review-provider.js";
import { runMetrics } from "../src/evaluation.js";
import { mkdirSync, mkdtempSync } from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
const data = loadDataset(resolve(ROOT, "data/synthetic/dataset.json"));
const request = Request.parse({
  userId: "review-user",
  conversationId: "c",
  request: "画像",
});

for (const architecture of ["multi-agent", "skills"] as const)
  test(`${architecture}: ordinary reviewer JSON preserves raw responses and accepted transport without skipping validation or draft repair`, async () => {
    const store = new Store(":memory:"),
      provider = reviewProvider();
    try {
      const runtime = new Runtime(
        store,
        new Knowledge(data),
        {
          ...provider,
          async complete(...args) {
            const reply = await provider.complete(...args);
            const calls = reply.message.tool_calls;
            if (
              calls?.length === 1 &&
              calls[0]!.function.name === "final_review_submit"
            )
              return {
                ...reply,
                finishReason: "stop",
                message: {
                  role: "assistant" as const,
                  content: calls[0]!.function.arguments,
                },
              };
            return reply;
          },
        },
        { ...config(), finalReview: "model" },
      );
      const run = runtime.create({ ...request, architecture });
      const done = await runtime.execute(run.id, request.userId);
      assert.equal(done.finalReview!.status, "model_checked");
      assert.equal(done.finalReview!.revisions, 1);
      const transports = store
        .cacheEntries(run.id, "final:")
        .filter((c) => c.key.endsWith(":transport"));
      assert.equal(transports.length, 2);
      assert(
        transports.every(
          (c) =>
            (c.value as any).transport === "json_content" &&
            (c.value as any).attempt === 0,
        ),
      );
      const calls = store
        .modelCalls(run.id)
        .filter((c) => String(c.scope).startsWith("final-review:"));
      assert.equal(calls.length, 2);
      assert(
        calls.every(
          (c) => !(c.response as any).tool_calls && c.finishReason === "stop",
        ),
      );
    } finally {
      store.close();
    }
  });
test("final inspection rejects fabricated quotes and checks draft extractions against authoritative facts", () => {
  const facts = finalFacts(request, [], "synthetic");
  const input = {
    factsHash: facts.factsHash,
    audit: {
      units: [
        {
          unitIds: [0],
          kind: "execution",
          verdict: "supported",
          citations: [{ sourceId: "facts", quote: "expertCount" }],
          reason: "",
        },
      ],
      changes: [],
      hardConditionCounts: [],
    },
    extracted: {
      expertCount: 3,
      steps: [{ stepId: "invented", status: "succeeded" }],
      salaryFilter: "requested",
      recruitment: "active",
    },
    issues: [],
  };
  assert.equal(
    inspectFinal("三位专家", input, facts, [
      { id: "facts", kind: "control", text: JSON.stringify(facts) },
    ]).problems.length,
    4,
  );
  assert.throws(
    () => inspectFinal("草稿", { ...input, factsHash: "wrong" }, facts, []),
    /hash/,
  );
  assert.throws(
    () =>
      inspectFinal(
        "草稿",
        { ...input, issues: [{ excerpt: "不存在", reason: "虚构审阅" }] },
        facts,
        [],
      ),
    /absent/,
  );
});
for (const architecture of ["multi-agent", "skills"] as const) {
  test(`${architecture}: altered persisted final facts cannot reach synthesis or review`, async () => {
    const s = new Store(":memory:");
    try {
      const record = s.recordFinal.bind(s);
      s.recordFinal = (id, key, value) =>
        record(
          id,
          key,
          key === "final:facts"
            ? { ...(value as object), expertCount: 999 }
            : value,
        );
      const rt = new Runtime(s, new Knowledge(data), reviewProvider(), {
        ...config(),
        finalReview: "model",
      });
      const run = rt.create({ ...request, architecture });
      const done = await rt.execute(run.id, request.userId);
      assert.equal(done.status, "failed");
      assert.match(done.error!, /Saved final facts disagree/);
      assert.equal(s.modelCalls(run.id).length, 2);
      assert.equal(s.cache(run.id, "final:draft:0"), undefined);
      assert.equal(s.cache(run.id, "final:receipt"), undefined);
    } finally {
      s.close();
    }
  });
  test(`${architecture}: final review repairs once and retains both drafts and exact accounted calls`, async () => {
    const s = new Store(":memory:");
    try {
      const provider = reviewProvider();
      const factsReceived: unknown[] = [];
      const rt = new Runtime(
        s,
        new Knowledge(data),
        {
          ...provider,
          async complete(messages, tools, signal, delta) {
            if (
              !tools.length ||
              tools.some((t) => t.function.name === "final_review_submit")
            ) {
              const text = messages.at(-1)!.content!;
              factsReceived.push(
                JSON.parse(text.slice(text.indexOf("{"))).facts,
              );
            }
            return provider.complete(messages, tools, signal, delta);
          },
        },
        {
          ...config(),
          finalReview: "model",
        },
      );
      const r = rt.create({ ...request, architecture });
      const done = await rt.execute(r.id, request.userId);
      assert.equal(done.status, "partial");
      assert.equal(done.finalReview!.status, "model_checked");
      assert.equal(done.finalReview!.revisions, 1);
      assert.match(done.answer!, /^修订/);
      assert.match(s.cache(r.id, "final:draft:0") as string, /三位/);
      assert.match(s.cache(r.id, "final:draft:1") as string, /一位/);
      const metrics = runMetrics(s, r.id);
      assert.equal(metrics.finalReviewModelCalls, 2);
      assert.equal(metrics.finalRevisionModelCalls, 1);
      assert.equal(metrics.modelCalls, 6);
      assert.equal(factsReceived.length, 4); // synthesize, review, repair, review
      for (const facts of factsReceived)
        assert.deepEqual(facts, s.cache(r.id, "final:facts"));
      assert.equal((factsReceived[0] as any).coordination.available, true);
      assert.equal((factsReceived[0] as any).coordination.roundsUsed, 0);
    } finally {
      s.close();
    }
  });
  test(`${architecture}: an ambiguous receipt return honors its committed answer`, async () => {
    const s = new Store(":memory:");
    try {
      const cfg = { ...config(), finalReview: "model" as const };
      let crash = true;
      const record = s.recordFinal.bind(s);
      s.recordFinal = (id, key, value) => {
        const saved = record(id, key, value);
        if (crash && key === "final:receipt") {
          crash = false;
          throw Error("simulated checkpoint window");
        }
        return saved;
      };
      const rt = new Runtime(s, new Knowledge(data), reviewProvider(), cfg);
      const r = rt.create({ ...request, architecture });
      const done = await rt.execute(r.id, request.userId);
      assert.match(done.answer!, /^修订/);
      assert.equal(done.finalReview!.status, "model_checked");
      assert.equal(
        s
          .events(r.id)
          .filter(
            (e) =>
              e.type === "final.review" &&
              (e.payload as any).key === "final:receipt",
          ).length,
        1,
      );
    } finally {
      s.close();
    }
  });
  for (const boundary of ["receipt", "response"]) {
    test(`${architecture}: actual kill after final ${boundary} recovers without additional calls at the call ceiling`, async () => {
      mkdirSync(resolve(ROOT, "var/tests"), { recursive: true });
      const db = resolve(
        mkdtempSync(resolve(ROOT, "var/tests/final-review-")),
        "runs.sqlite",
      );
      let s = new Store(db);
      const cfg = {
        ...config(),
        finalReview: "model" as const,
        maxCalls: 6,
        leaseTtlMs: 1500,
      };
      const r = new Runtime(
        s,
        new Knowledge(data),
        reviewProvider(),
        cfg,
      ).create({ ...request, architecture });
      s.close();
      const child = spawn(
        process.execPath,
        [
          resolve(ROOT, "dist/tests/fixtures/final-review-worker.js"),
          db,
          r.id,
          request.userId,
          boundary,
        ],
        { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
      );
      let err = "";
      child.stderr.on("data", (b) => {
        err += String(b);
      });
      const timeout = setTimeout(() => child.kill("SIGKILL"), 10000);
      const [code] = await once(child, "exit");
      clearTimeout(timeout);
      s = new Store(db);
      try {
        assert.notEqual(code, 0, err);
        assert.equal(s.modelCalls(r.id).length, 6, err);
        assert.equal(s.run(r.id).status, "running");
        const lease = s.db
          .prepare("SELECT expires FROM leases WHERE resource=?")
          .get(r.id)!;
        await delay(Math.max(1, Number(lease.expires) - Date.now() + 60));
        const done = await new Runtime(
          s,
          new Knowledge(data),
          {
            ...reviewProvider(),
            async complete() {
              throw Error("Unexpected new model call");
            },
          },
          cfg,
        ).execute(r.id, request.userId);
        assert.equal(done.finalReview!.status, "model_checked", done.error);
        assert.match(done.answer!, /^修订/);
        assert.equal(s.modelCalls(r.id).length, 6);
        assert.equal(
          s
            .events(r.id)
            .filter(
              (e) =>
                e.type === "final.review" &&
                (e.payload as any).key === "final:receipt",
            ).length,
          1,
        );
      } finally {
        s.close();
      }
    });
  }
}
for (const mode of ["always-wrong", "malformed", "limit"] as const) {
  test(`unresolved or unavailable final review withholds the draft: ${mode}`, async () => {
    const s = new Store(":memory:");
    try {
      const cfg = {
        ...config(),
        finalReview: "model" as const,
        ...(mode === "limit" ? { maxCalls: 3 } : {}),
      };
      const rt = new Runtime(
        s,
        new Knowledge(data),
        reviewProvider(mode === "limit" ? "repair" : mode),
        cfg,
      );
      const r = rt.create(request);
      const done = await rt.execute(r.id, request.userId);
      assert.equal(done.status, "partial");
      assert.equal(done.finalReview!.status, "withheld");
      assert.match(done.answer!, /未作为最终建议发布/);
      assert(!done.answer!.includes("三位"));
      assert(s.cache(r.id, "final:draft:0"));
      assert(s.modelCalls(r.id).length <= 6);
    } finally {
      s.close();
    }
  });
}
test("cancellation during final review prevents a receipt or publication", async () => {
  const s = new Store(":memory:");
  try {
    let id = "";
    const base = reviewProvider();
    const provider = {
      ...base,
      async complete(...args: Parameters<typeof base.complete>) {
        if (args[1].some((t) => t.function.name === "final_review_submit"))
          s.cancel(id, request.userId);
        return base.complete(...args);
      },
    };
    const rt = new Runtime(s, new Knowledge(data), provider, {
      ...config(),
      finalReview: "model",
    });
    const r = rt.create(request);
    id = r.id;
    const done = await rt.execute(id, request.userId);
    assert.equal(done.status, "cancelled");
    assert.equal(s.cache(id, "final:receipt"), undefined);
    assert.equal(done.answer, undefined);
  } finally {
    s.close();
  }
});
