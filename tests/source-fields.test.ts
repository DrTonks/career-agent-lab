import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { jsonSpans } from "../src/json-locations.js";
import { structuredSource, reviewSourceHash } from "../src/source-fields.js";
import {
  reviewSourceDirectory,
  readReviewEvidence,
  ReviewEvidenceRead,
  admitReviewPages,
} from "../src/review-evidence.js";
import { calculationEvidence } from "../src/calculation.js";
import {
  calculationFacts,
  countCandidates,
} from "../src/calculation-review.js";
import { citationCatalog } from "../src/review-submission.js";
import { deepseekStrictSchema } from "../src/provider-request.js";
import type { ReviewSource } from "../src/assertion-review.js";

const artifact = (value: unknown): ReviewSource => ({
  id: "result:profile",
  kind: "artifact",
  text: JSON.stringify(value),
});
const field = (s: ReviewSource, pointer: string) => ({
  sourceId: s.id,
  sourceHash: reviewSourceHash(s),
  pointer,
});
const read = (s: ReviewSource, pointer: string) =>
  readReviewEvidence({ requests: [field(s, pointer)] }, [s]);
function receipt(categories: string[] = []) {
  const e = calculationEvidence({
    runId: "r",
    executionId: "match",
    role: "match",
    constraintVersion: 1,
    datasetVersion: "d",
    knowledgeHash: "k",
    tool: "jobs_search",
    arguments: { query: "前端", categoryIds: categories },
    result: {
      appliedConstraints: { cities: ["北京"], weekendsOff: true },
      padding: "UNREAD_GAP".repeat(1500),
      counts: { beforeFilter: 24, eligible: 0, unknown: 3 },
      categoryCoverage: [
        {
          categoryId: "frontend-junior",
          totalInSelectedCorpus: 4,
          eligible: 0,
          uncertain: 1,
        },
      ],
      dataScope: { source: "synthetic" },
    },
  });
  return {
    id: "calc",
    kind: "calculation",
    text: e.text,
    origin: { sourceId: e.id, version: e.version, artifactId: "r:match" },
  } satisfies ReviewSource;
}

test("canonical JSON fields locate duplicate values, escaped keys, arrays and Unicode by exact pointer", () => {
  const v = {
    "a/b": { "~key": '😀引号"斜杠\\', same: 7 },
    other: { same: 7 },
    list: [7, null, false],
  };
  const text = JSON.stringify(v),
    index = jsonSpans(v, text);
  for (const [p, s] of index)
    assert.deepEqual(JSON.parse(text.slice(s.start, s.end)), s.value, p);
  assert.notEqual(
    index.get("/a~1b/same")!.start,
    index.get("/other/same")!.start,
  );
  assert.equal(index.get("/a~1b/~0key")!.value, v["a/b"]["~key"]);
  assert.equal(index.get("/list/1")!.value, null);
  for (const malformed of ['{"a":1,"a":2}', '{ "a":2}', '{"a":'])
    assert.throws(() => jsonSpans(JSON.parse(malformed), malformed));
});

test("directory is bounded metadata; omitted/deeper fields remain exactly readable without promoting values to evidence", () => {
  const s = artifact({
    artifact: {
      scores: { learning: null },
      completeness: 0.42,
      ...Object.fromEntries(
        Array.from({ length: 35 }, (_, i) => [
          `field${i}`,
          `PRIVATE_VALUE_${i}`,
        ]),
      ),
    },
  });
  const dir = reviewSourceDirectory([s])[0]!.structured!;
  assert.equal(dir.fields.length, 24);
  assert(dir.omittedFields > 0);
  assert(!JSON.stringify(dir).includes("PRIVATE_VALUE"));
  const pages = read(s, "/artifact/scores/learning");
  assert.equal(pages[0]!.text, '"learning":null');
  assert.equal(citationCatalog([]).length, 0);
  assert(citationCatalog(pages).some((x) => x.text === '"learning":null'));
  assert.equal(
    read(s, "/artifact/field34")[0]!.text,
    '"field34":"PRIVATE_VALUE_34"',
  );
});

test("field read rejects stale identity, unlisted sources, unknown pointers and noncanonical/partial bodies", () => {
  const s = artifact({ artifact: { scores: { learning: null } } }),
    request = { requests: [field(s, "/artifact/scores")] };
  for (const altered of [
    { ...s, text: s.text.replace("null", "50") },
    {
      ...s,
      origin: { sourceId: "other-run", version: "2", artifactId: "other" },
    },
  ])
    assert.throws(() => readReviewEvidence(request, [altered]), /hash changed/);
  assert.throws(() => readReviewEvidence(request, []), /not authorized/);
  assert.throws(() => read(s, "/artifact/unknown"), /pointer not found/);
  for (const text of [
    '{"artifact":',
    '{ "artifact":{} }',
    '{"artifact":{},"artifact":{}}',
  ]) {
    const partial = { ...s, text };
    assert.equal(structuredSource(partial), undefined);
    assert.throws(() => read(partial, ""), /index unavailable/);
    assert.equal(
      readReviewEvidence(
        { requests: [{ sourceId: s.id, offset: 0, maxChars: 6000 }] },
        [partial],
      )[0]!.text,
      text,
    );
  }
  assert.throws(() =>
    ReviewEvidenceRead.parse({
      requests: [{ ...field(s, ""), offset: 0, maxChars: 10 }],
    }),
  );
  assert.doesNotThrow(() =>
    deepseekStrictSchema(z.toJSONSchema(ReviewEvidenceRead)),
  );
});

test("hash-verified calculation fields carry exact query and scope ranges, never bridge a large unread gap", () => {
  const s = receipt(),
    pages = read(s, "/result/counts");
  assert(pages.length > 1);
  assert(!pages.some((p) => p.text.includes("UNREAD_GAP")));
  for (const p of pages)
    assert.equal(p.text, s.text.slice(p.window!.start, p.window!.end));
  const candidates = countCandidates([
    { id: 0, text: "语料共24条，合格0条，待核实3条" },
  ]);
  const facts = calculationFacts(pages, [s], candidates);
  assert.deepEqual(
    facts.map((f) => f.value).sort((a, b) => a - b),
    [0, 3, 24],
  );
  assert.deepEqual(facts[0]!.scope.arguments, {
    query: "前端",
    categoryIds: [],
  });
  assert.deepEqual(facts[0]!.scope.appliedConstraints, {
    cities: ["北京"],
    weekendsOff: true,
  });
  assert.equal(
    calculationFacts(
      pages.filter((p) => p.window!.start !== 0),
      [s],
      candidates,
    ).length,
    0,
  );
  const row = read(s, "/result/categoryCoverage/0/eligible");
  assert(row.some((p) => p.text.includes('"categoryId":"frontend-junior"')));
  assert.equal(
    calculationFacts(row, [s], candidates).find(
      (f) => f.scope.categoryId && f.pointer.endsWith("/eligible"),
    )?.value,
    0,
  );
  const wrong = { ...s, text: s.text.replace('"unknown":3', '"unknown":99') };
  assert.equal(reviewSourceDirectory([wrong])[0]!.structured, undefined);
  assert.throws(() => read(wrong, "/result/counts"), /index unavailable/);
});

test("same values from distinct queries keep distinct hashes/scopes; partial admission never fabricates complete evidence", () => {
  const a = receipt(),
    b = { ...receipt(["frontend-junior"]), id: "subset" };
  assert.notEqual(reviewSourceHash(a), reviewSourceHash(b));
  assert.throws(
    () =>
      readReviewEvidence(
        { requests: [{ ...field(a, "/result/counts"), sourceId: b.id }] },
        [b],
      ),
    /hash changed/,
  );
  const candidates = countCandidates([{ id: 0, text: "检索合格0条" }]);
  const facts = calculationFacts(
    [...read(a, "/result/counts"), ...read(b, "/result/counts")],
    [a, b],
    candidates,
  );
  assert.equal(facts.length, 2);
  assert.notEqual(facts[0]!.id, facts[1]!.id);
  assert.notDeepEqual(facts[0]!.scope.arguments, facts[1]!.scope.arguments);
  const admitted = admitReviewPages(
    "irrelevant",
    [a],
    100,
    [],
    read(a, "/result/counts"),
  );
  assert(admitted.error);
  assert.equal(calculationFacts(admitted.selected, [a], candidates).length, 0);
});

test("large field bundles require explicit pagination, while a canonical authorized subsection never grants its parent", () => {
  const s = artifact({ artifact: { long: "x".repeat(7000), score: 42 } });
  assert.throws(() => read(s, "/artifact/long"), /exceeds 6000.*offset/);
  assert.equal(read(s, "/artifact/score")[0]!.text, '"score":42');
  const subsection = {
    id: "published-page",
    kind: "artifact",
    text: '{"score":42}',
    window: { parentId: "unseen", start: 9000, end: 9012, total: 20000 },
  };
  const p = read(subsection, "/score")[0]!;
  assert.equal(p.text, '"score":42');
  assert.equal(p.window!.parentId, "published-page");
  assert.throws(
    () =>
      readReviewEvidence(
        { requests: [{ sourceId: "unseen", offset: 0, maxChars: 200 }] },
        [subsection],
      ),
    /not authorized/,
  );
});
