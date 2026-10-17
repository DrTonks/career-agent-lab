import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { resolve } from "node:path";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { config, ROOT, estimateTokens, hash } from "../src/config.js";
import {
  readReviewEvidence,
  reviewSourceDirectory,
  admitReviewPages,
} from "../src/review-evidence.js";
import { selectReviewSources } from "../src/review-plan.js";
import { calculationEvidence } from "../src/calculation.js";
import { citationCatalog } from "../src/review-submission.js";
import { Store } from "../src/storage.js";
import { Runtime } from "../src/runtime.js";
import { Knowledge } from "../src/retrieval.js";
import { loadDataset } from "../src/data.js";
import type { ReviewSource } from "../src/assertion-review.js";
import {
  evidenceProvider,
  evidenceResume,
} from "./fixtures/review-evidence-provider.js";
const data = loadDataset(resolve(ROOT, "data/synthetic/dataset.json"));

test("batch read admits fitting pages in request order, rejects whole oversized pages and deterministically preserves accepted evidence", () => {
  const sources: ReviewSource[] = [
    { id: "facts", kind: "control", text: "mandatory" },
    { id: "a", kind: "job", text: "a".repeat(800) },
    { id: "b", kind: "job", text: "b".repeat(800) },
    { id: "c", kind: "job", text: "c".repeat(80) },
  ];
  const request = readReviewEvidence(
    {
      requests: [
        { sourceId: "a", offset: 0, maxChars: 6000 },
        { sourceId: "b", offset: 0, maxChars: 6000 },
        { sourceId: "c", offset: 0, maxChars: 6000 },
      ],
    },
    sources,
  );
  const result = admitReviewPages("unrelated", sources, 850, [], request);
  assert.deepEqual(
    result.pinned.map((s) => s.id),
    ["a", "c"],
  );
  assert.deepEqual(
    JSON.parse(result.error!).rejected.map((x: any) => x.sourceId),
    ["b"],
  );
  assert(estimateTokens(JSON.stringify(result.selected)) <= 850);
  assert(!result.selected.some((s) => s.id === "b"));
  assert.deepEqual(
    admitReviewPages("unrelated", sources, 850, result.pinned, request),
    result,
  );
});

test("review read is limited to authorized published pages, exact Unicode slices and explicit capacity", () => {
  const sources: ReviewSource[] = [
    { id: "facts", kind: "control", text: "authoritative facts" },
    { id: "e0", kind: "job", text: "前😀后" },
    { id: "e1", kind: "job", text: "x".repeat(12000) },
  ];
  assert.throws(
    () =>
      readReviewEvidence(
        { requests: [{ sourceId: "private", offset: 0, maxChars: 5 }] },
        sources,
      ),
    /not authorized/,
  );
  assert.throws(
    () =>
      readReviewEvidence(
        { requests: [{ sourceId: "e0", offset: 8, maxChars: 5 }] },
        sources,
      ),
    /out of range/,
  );
  assert.throws(() =>
    readReviewEvidence(
      { requests: [{ sourceId: "e0", offset: 0, maxChars: 6001 }] },
      sources,
    ),
  );
  const pages = readReviewEvidence(
    { requests: [{ sourceId: "e0", offset: 2, maxChars: 1 }] },
    sources,
  );
  assert.equal(pages[0]!.text, "😀");
  assert.equal(pages[0]!.window!.start, 1);
  const selected = selectReviewSources("unrelated", sources, 250, pages);
  assert(selected.some((s) => s.text === "😀"));
  assert(estimateTokens(JSON.stringify(selected)) <= 250);
  const oversized = readReviewEvidence(
    { requests: [{ sourceId: "e1", offset: 0, maxChars: 6000 }] },
    sources,
  );
  assert.throws(
    () => selectReviewSources("x", sources, 250, oversized),
    /mandatory/,
  );
  assert(!citationCatalog(pages).some((c) => c.text.includes("前")));
});

test("calculation directory locates scoped receipts but supplies no citation evidence or unverified body projection", () => {
  const e = calculationEvidence({
    runId: "r",
    executionId: "match",
    role: "match",
    constraintVersion: 1,
    datasetVersion: "d",
    knowledgeHash: "k",
    tool: "jobs_search",
    arguments: { query: "成都 QA", categoryIds: ["qa-junior"] },
    result: { counts: { eligible: 1 } },
  });
  const source: ReviewSource = {
    id: "e0",
    kind: "calculation",
    text: e.text,
    origin: { sourceId: e.id, version: e.version, artifactId: "a" },
  };
  const directory = reviewSourceDirectory([source]);
  assert.equal(directory[0]!.calculation!.tool, "jobs_search");
  assert.deepEqual(directory[0]!.calculation!.fields, ["counts"]);
  assert(!JSON.stringify(directory).includes('"eligible"'));
  const tampered = reviewSourceDirectory([
    { ...source, text: source.text.replace('"eligible":1', '"eligible":99') },
  ]);
  assert.equal(tampered[0]!.calculation, undefined);
  const pages = readReviewEvidence(
    { requests: [{ sourceId: "e0", offset: 0, maxChars: 6000 }] },
    [source],
  );
  assert.equal(pages[0]!.text, e.text);
});

for (const architecture of ["multi-agent", "skills"] as const) {
  test(`${architecture}: cancellation before read persistence and altered read receipt cannot publish`, async () => {
    for (const mode of ["cancel", "tamper"] as const) {
      const store = new Store(":memory:");
      try {
        const base = evidenceProvider();
        let runId = "";
        const provider = {
          ...base,
          async complete(...args: Parameters<typeof base.complete>) {
            const reply = await base.complete(...args);
            if (
              mode === "cancel" &&
              reply.message.tool_calls?.[0]?.function.name ===
                "final_evidence_read"
            )
              store.cancel(runId, "review-reader");
            return reply;
          },
        };
        if (mode === "tamper") {
          const record = store.recordFinal.bind(store);
          store.recordFinal = (id, key, value) => {
            const saved = record(id, key, value);
            return key.includes(":evidence:")
              ? { ...(saved as object), selectionHash: "altered" }
              : saved;
          };
        }
        const rt = new Runtime(store, new Knowledge(data), provider, {
          ...config(),
          finalReview: "model",
        });
        const run = rt.create({
          userId: "review-reader",
          conversationId: "c",
          request: "画像",
          resumeText: evidenceResume,
          architecture,
        });
        runId = run.id;
        const done = await rt.execute(runId, run.request.userId);
        if (mode === "cancel") {
          assert.equal(done.status, "cancelled");
          assert.equal(
            store.cache(runId, "final:part:0:0:evidence:0"),
            undefined,
          );
          assert.equal(store.cache(runId, "final:receipt"), undefined);
        } else {
          assert.equal(done.finalReview?.status, "withheld");
          assert.match(
            done.finalReview!.reason!,
            /evidence read identity mismatch/,
          );
        }
      } finally {
        store.close();
      }
    }
  });
  for (const mode of [
    "normal",
    "invalid-first",
    "format",
    "repeat",
    "field",
    "supplemental",
  ] as const) {
    test(`${architecture}: bounded review evidence ${mode} preserves actual source binding`, async () => {
      const store = new Store(":memory:");
      try {
        const rt = new Runtime(
          store,
          new Knowledge(data),
          evidenceProvider(mode),
          { ...config(), finalReview: "model" },
        );
        const r = rt.create({
          userId: "review-reader",
          conversationId: "c",
          request: "画像",
          resumeText: evidenceResume,
          architecture,
        });
        const done = await rt.execute(r.id, r.request.userId);
        assert.equal(
          done.finalReview?.status,
          mode === "repeat" ? "withheld" : "model_checked",
          done.finalReview?.reason,
        );
        const reads = store.db
          .prepare(
            "SELECT result FROM tool_cache WHERE run_id=? AND key LIKE ?",
          )
          .all(r.id, "final:part:0:0:evidence:%")
          .map((x) => JSON.parse(String(x.result)));
        assert.equal(
          reads.length,
          ["invalid-first", "repeat"].includes(mode) ? 2 : 1,
        );
        for (const read of reads)
          assert.equal(read.selectionHash, hash(read.selected));
        assert.equal(
          store.modelCalls(r.id).length,
          ["normal", "field", "supplemental"].includes(mode)
            ? 5
            : mode === "repeat"
              ? 7
              : 6,
        );
        if (mode === "supplemental") {
          const transport = store
            .cacheEntries(r.id, "final:")
            .filter((x) => x.key.endsWith(":transport"));
          assert(transport.length > 0);
          assert(
            transport.every(
              (x) => (x.value as any).supplementalContent === true,
            ),
          );
          assert(
            store
              .modelCalls(r.id)
              .filter((c) => String(c.scope).startsWith("final-review:"))
              .every((c) =>
                (c.response as any).content?.startsWith("I'll check"),
              ),
          );
        }
        if (mode === "repeat")
          assert(reads.every((x) => x.error.includes("not authorized")));
        else
          assert(
            reads
              .at(-1)
              .selected.some((s: any) =>
                s.text.includes(
                  mode === "field" ? "FIELD_SECRET" : "TAIL_SECRET",
                ),
              ),
          );
      } finally {
        store.close();
      }
    });
  }
  test(`${architecture}: competing structured content prevents read execution instead of choosing one submission silently`, async () => {
    const store = new Store(":memory:"),
      provider = evidenceProvider();
    try {
      const rt = new Runtime(
        store,
        new Knowledge(data),
        {
          ...provider,
          async complete(...args) {
            const reply = await provider.complete(...args);
            if (
              reply.message.tool_calls?.some(
                (c) => c.function.name === "final_evidence_read",
              )
            )
              reply.message.content = JSON.stringify({
                competingSubmission: true,
              });
            return reply;
          },
        },
        { ...config(), finalReview: "model" },
      );
      const run = rt.create({
        userId: "u",
        conversationId: "c",
        request: "画像",
        resumeText: evidenceResume,
        architecture,
      });
      const done = await rt.execute(run.id, "u");
      assert.equal(done.finalReview?.status, "withheld");
      assert.equal(store.cache(run.id, "final:part:0:0:evidence:0"), undefined);
    } finally {
      store.close();
    }
  });
  for (const readMode of ["normal", "field", "supplemental"] as const) {
    for (const boundary of ["response", "read-receipt"] as const) {
      test(`${architecture}: real kill after ${readMode} evidence ${boundary} reuses response and read at call ceiling`, async () => {
        mkdirSync(resolve(ROOT, "var/tests"), { recursive: true });
        const db = resolve(
          mkdtempSync(resolve(ROOT, "var/tests/review-evidence-")),
          "runs.sqlite",
        );
        let store = new Store(db);
        const cfg = {
          ...config(),
          finalReview: "model" as const,
          maxCalls: 5,
          leaseTtlMs: 1500,
        };
        const run = new Runtime(
          store,
          new Knowledge(data),
          evidenceProvider(readMode),
          cfg,
        ).create({
          userId: "review-reader",
          conversationId: "c",
          request: "画像",
          resumeText: evidenceResume,
          architecture,
        });
        store.close();
        const child = spawn(
          process.execPath,
          [
            resolve(ROOT, "dist/tests/fixtures/review-evidence-worker.js"),
            db,
            run.id,
            run.request.userId,
            boundary,
            readMode,
          ],
          { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
        );
        let stderr = "";
        child.stderr.on("data", (x) => (stderr += String(x)));
        const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
        const [code] = await once(child, "exit");
        clearTimeout(timer);
        assert.notEqual(code, 0, stderr);
        store = new Store(db);
        try {
          assert.equal(store.modelCalls(run.id).length, 4, stderr);
          const key = "final:part:0:0:evidence:0";
          assert.equal(
            store.cache(run.id, key) !== undefined,
            boundary === "read-receipt",
          );
          const lease = store.db
            .prepare("SELECT expires FROM leases WHERE resource=?")
            .get(run.id)!;
          await delay(Math.max(1, Number(lease.expires) - Date.now() + 60));
          let calls = 0;
          const base = evidenceProvider(readMode);
          const provider = {
            ...base,
            async complete(...args: Parameters<typeof base.complete>) {
              calls++;
              assert.equal(
                JSON.parse(args[0][1]!.content!).evidenceRead.history.length,
                1,
              );
              return base.complete(...args);
            },
          };
          const done = await new Runtime(
            store,
            new Knowledge(data),
            provider,
            cfg,
          ).execute(run.id, run.request.userId);
          assert.equal(
            done.finalReview?.status,
            "model_checked",
            done.finalReview?.reason,
          );
          assert.equal(calls, 1);
          assert.equal(store.modelCalls(run.id).length, 5);
          assert(store.cache(run.id, key));
          assert.equal(
            store.db
              .prepare(
                "SELECT count(*) n FROM tool_cache WHERE run_id=? AND key=?",
              )
              .get(run.id, key)!.n,
            1,
          );
        } finally {
          store.close();
        }
      });
    }
  }
}
