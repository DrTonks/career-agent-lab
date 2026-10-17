import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { config, ROOT } from "../src/config.js";
import { Request, type ModelProvider } from "../src/contracts.js";
import { Store } from "../src/storage.js";
import { Runtime } from "../src/runtime.js";
import { Knowledge } from "../src/retrieval.js";
import { loadDataset } from "../src/data.js";
import { finalFacts, inspectFinal } from "../src/final-review.js";
import { reviewSources, reviewUnits } from "../src/assertion-review.js";
import {
  planReview,
  validatedReview,
  selectReviewSources,
  inspectGlobal,
} from "../src/review-plan.js";
import {
  segmentedProvider,
  segmentedDraft,
} from "./fixtures/segmented-review-provider.js";
const data = loadDataset(resolve(ROOT, "data/synthetic/dataset.json"));
const request = Request.parse({
  userId: "segmented-user",
  conversationId: "c",
  request: "画像",
});
const facts = finalFacts(request, [], "synthetic");
const standards = ["profile", "match", "path", "report"].map((role) => ({
  id: `rule:${role}`,
  text: readFileSync(resolve(ROOT, `knowledge/${role}.md`), "utf8"),
}));
test("review plan retains global IDs and exact windows; omitted text cannot be cited", () => {
  const original =
    "前文".repeat(1600) + "TAIL_TARGET 只接受博士学历" + "结尾".repeat(100);
  const sources = reviewSources(request, [], facts, standards).concat([
    { id: "job:x", kind: "job", text: original },
  ]);
  const selected = selectReviewSources("TAIL_TARGET 博士学历", sources, 8000);
  const hit = selected.find((s) => s.text.includes("TAIL_TARGET"))!;
  assert(hit.window);
  assert.equal(hit.text, original.slice(hit.window.start, hit.window.end));
  const plan = planReview(segmentedDraft(), sources);
  assert.equal(plan.parts.length, 3);
  assert.deepEqual(
    plan.parts.flatMap((p) => p.units.map((u) => u.id)),
    Array.from({ length: 48 }, (_, i) => i),
  );
  assert(plan.globalRequired);
  assert.throws(
    () =>
      inspectGlobal(
        segmentedDraft(),
        { planHash: "wrong", comparisons: [] },
        plan,
      ),
    /hash/,
  );
  assert.throws(
    () =>
      inspectGlobal(
        segmentedDraft(),
        {
          planHash: plan.planHash,
          comparisons: [
            {
              firstUnitId: 0,
              secondUnitId: 999,
              relation: "contradiction",
              scope: "same",
              reason: "x",
              incompatibility: "x",
            },
          ],
        },
        plan,
      ),
    /unknown/,
  );
  const raw = {
    factsHash: facts.factsHash,
    audit: {
      units: [
        {
          unitIds: [16],
          kind: "execution",
          verdict: "supported",
          citations: [{ sourceId: "job:x", quote: "TAIL_TARGET" }],
          reason: "",
        },
      ],
      changes: [],
      hardConditionCounts: [],
    },
    extracted: {
      expertCount: null,
      steps: [],
      salaryFilter: null,
      recruitment: null,
    },
    issues: [],
  };
  assert.throws(
    () => inspectFinal(segmentedDraft(), raw, facts, selected, [16]),
    /citation absent/,
  );
  raw.audit.units[0]!.citations = [{ sourceId: hit.id, quote: "TAIL_TARGET" }];
  assert.deepEqual(
    inspectFinal(segmentedDraft(), raw, facts, selected, [16]).problems,
    [],
  );
  assert.throws(
    () => inspectFinal(segmentedDraft(), raw, facts, selected, [17]),
    /every draft unit/,
  );
});
for (const architecture of ["multi-agent", "skills"] as const) {
  test(`${architecture}: every part and global consistency are repeated after repair`, async () => {
    const s = new Store(":memory:");
    try {
      const rt = new Runtime(
        s,
        new Knowledge(data),
        segmentedProvider("repair"),
        { ...config(), finalReview: "model" },
      );
      const r = rt.create({ ...request, architecture });
      const done = await rt.execute(r.id, request.userId);
      assert.equal(
        done.finalReview?.status,
        "model_checked",
        done.finalReview?.reason,
      );
      assert.equal(done.finalReview.revisions, 1);
      assert(!done.answer?.includes("三位"));
      for (const round of [0, 1]) {
        const plan = s.cache(r.id, `final:plan:${round}`) as ReturnType<
          typeof planReview
        >;
        assert.equal(plan.parts.length, 3);
        for (const p of plan.parts)
          assert(s.cache(r.id, `final:part:${round}:${p.id}`));
        assert(s.cache(r.id, `final:global:${round}`));
        const aggregate = s.cache(r.id, `final:inspection:${round}`) as any;
        assert.equal(aggregate.parts.length, 3);
      }
      assert.equal(s.modelCalls(r.id).length, 12);
    } finally {
      s.close();
    }
  });
  for (const boundary of ["receipt", "response"]) {
    test(`${architecture}: process kill after part ${boundary} resumes only unfinished parts at call ceiling`, async () => {
      mkdirSync(resolve(ROOT, "var/tests"), { recursive: true });
      const db = resolve(
        mkdtempSync(resolve(ROOT, "var/tests/segmented-review-")),
        "runs.sqlite",
      );
      let s = new Store(db);
      const cfg = {
        ...config(),
        finalReview: "model" as const,
        maxCalls: 7,
        leaseTtlMs: 1500,
      };
      const r = new Runtime(
        s,
        new Knowledge(data),
        segmentedProvider(),
        cfg,
      ).create({ ...request, architecture });
      s.close();
      const child = spawn(
        process.execPath,
        [
          resolve(ROOT, "dist/tests/fixtures/segmented-review-worker.js"),
          db,
          r.id,
          request.userId,
          boundary,
        ],
        { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
      );
      let err = "";
      child.stderr.on("data", (b) => (err += String(b)));
      const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
      const [code] = await once(child, "exit");
      clearTimeout(timer);
      s = new Store(db);
      try {
        assert.notEqual(code, 0, err);
        assert.equal(s.modelCalls(r.id).length, 5, err);
        const lease = s.db
          .prepare("SELECT expires FROM leases WHERE resource=?")
          .get(r.id)!;
        await delay(Math.max(1, Number(lease.expires) - Date.now() + 60));
        let newCalls = 0;
        const base = segmentedProvider();
        const provider: ModelProvider = {
          ...base,
          async complete(...args) {
            newCalls++;
            const payload = JSON.parse(args[0].at(-1)!.content!);
            if (payload.partId !== undefined) assert.equal(payload.partId, 2);
            return base.complete(...args);
          },
        };
        const done = await new Runtime(
          s,
          new Knowledge(data),
          provider,
          cfg,
        ).execute(r.id, request.userId);
        assert.equal(
          done.finalReview?.status,
          "model_checked",
          done.finalReview?.reason,
        );
        assert.equal(newCalls, 2);
        assert.equal(s.modelCalls(r.id).length, 7);
        assert.equal(
          s
            .events(r.id)
            .filter(
              (e) =>
                e.type === "final.review" &&
                (e.payload as any).key === "final:part:0:1",
            ).length,
          1,
        );
      } finally {
        s.close();
      }
    });
  }
}
for (const mode of ["global-conflict", "omit"] as const)
  test(`segmented final review does not publish on ${mode}`, async () => {
    const s = new Store(":memory:");
    try {
      const rt = new Runtime(s, new Knowledge(data), segmentedProvider(mode), {
        ...config(),
        finalReview: "model",
      });
      const r = rt.create(request);
      const done = await rt.execute(r.id, request.userId);
      assert.equal(done.finalReview?.status, "withheld");
      assert(!done.answer?.includes("记录47"));
    } finally {
      s.close();
    }
  });
test("preflight avoids starting a pass that cannot finish its planned call count", async () => {
  const s = new Store(":memory:");
  try {
    const rt = new Runtime(s, new Knowledge(data), segmentedProvider(), {
      ...config(),
      finalReview: "model",
      maxCalls: 6,
    });
    const r = rt.create(request);
    const done = await rt.execute(r.id, request.userId);
    assert.equal(done.finalReview?.status, "withheld");
    assert.match(done.finalReview.reason!, /planned review pass/);
    assert.equal(s.modelCalls(r.id).length, 3);
    assert(s.events(r.id).some((e) => e.type === "final.preflight"));
  } finally {
    s.close();
  }
});
test("cancellation between parts preserves receipts but never publishes", async () => {
  const s = new Store(":memory:");
  try {
    let id = "";
    const base = segmentedProvider();
    const provider: ModelProvider = {
      ...base,
      async complete(...args) {
        const result = await base.complete(...args);
        if (args[1][0]?.function.name === "final_review_submit") {
          const payload = JSON.parse(args[0].at(-1)!.content!);
          if (payload.partId === 1) s.cancel(id, request.userId);
        }
        return result;
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
    assert(s.cache(id, "final:part:0:0"));
    assert.equal(s.cache(id, "final:part:0:1"), undefined);
    assert.equal(s.cache(id, "final:receipt"), undefined);
  } finally {
    s.close();
  }
});

test("bounded review protocol correction records the invalid response and keeps semantic inspection intact", async () => {
  const s = new Store(":memory:");
  try {
    const base = segmentedProvider();
    let injected = false;
    const provider: ModelProvider = {
      ...base,
      async complete(messages, ...rest) {
        const corrected = messages.some(
          (m) => m.role === "user" && m.content?.includes('"validationError"'),
        );
        const original = corrected ? messages.slice(0, 2) : messages;
        const reply = await base.complete(original, ...rest);
        if (!injected && rest[0][0]?.function.name === "final_review_submit") {
          injected = true;
          const value = JSON.parse(
            reply.message.tool_calls![0]!.function.arguments,
          );
          delete value.changes;
          reply.message.tool_calls![0]!.function.arguments =
            JSON.stringify(value);
        }
        return reply;
      },
    };
    const rt = new Runtime(s, new Knowledge(data), provider, {
      ...config(),
      finalReview: "model",
    });
    const r = rt.create(request);
    const done = await rt.execute(r.id, request.userId);
    assert.equal(
      done.finalReview?.status,
      "model_checked",
      done.finalReview?.reason,
    );
    assert.equal(s.modelCalls(r.id).length, 8);
    assert(s.cache(r.id, "final:part:0:0:format-error"));
    assert.equal(
      s.modelCalls(r.id).filter((c) => String(c.scope).endsWith(":format:1"))
        .length,
      1,
    );
  } finally {
    s.close();
  }
});

test("protocol correction is bounded and never fills missing audit fields itself", async () => {
  let calls = 0,
    errors = 0;
  await assert.rejects(
    validatedReview(
      [],
      "final_review_submit",
      async () => {
        calls++;
        return {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "x",
                type: "function",
                function: { name: "final_review_submit", arguments: "{}" },
              },
            ],
          },
          usage: { input: 1, output: 1, cachedInput: 0 },
          finishReason: "tool_calls",
        };
      },
      () => {
        throw Error("required audit missing");
      },
      () => {
        errors++;
      },
    ),
    /required audit/,
  );
  assert.equal(calls, 2);
  assert.equal(errors, 1);
});
