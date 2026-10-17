import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  readdirSync,
} from "node:fs";
import { resolve } from "node:path";
import { ROOT } from "../src/config.js";
import { Store } from "../src/storage.js";
import { Knowledge } from "../src/retrieval.js";
import { loadDataset } from "../src/data.js";
import { chunkText } from "../src/chunking.js";
import {
  buildIndex,
  ExactVectors,
  type EmbeddingBackend,
} from "../src/vectors.js";

function directory() {
  mkdirSync(resolve(ROOT, "var/tests"), { recursive: true });
  return mkdtempSync(resolve(ROOT, "var/tests/retrieval-"));
}
const signal = () => new AbortController().signal;
const tokenCount = (s: string) => [...s].length + 2;
function backend(): EmbeddingBackend & { calls: number } {
  return {
    calls: 0,
    options: {
      baseUrl: "explicit-test-fixture",
      model: "fixture",
      revision: "a".repeat(40),
      dimensions: 2,
      queryPrefix: "query:",
      documentPrefix: "doc:",
    },
    countTokens: tokenCount,
    async encode(texts, s) {
      s.throwIfAborted();
      this.calls++;
      assert(texts.every((t) => tokenCount(t) <= 512));
      return {
        vectors: texts.map((t) => (t.includes("火星地质") ? [1, 0] : [0, 1])),
        tokens: null,
      };
    },
  };
}
function corpus() {
  const data = loadDataset(resolve(ROOT, "data/synthetic/dataset.json"));
  data.documents.push({
    id: "long",
    sourceId: "long-source",
    kind: "rule",
    roles: ["match"],
    text: "常规岗位描述。".repeat(800) + "必须熟悉火星地质，且限定夜班。",
  });
  data.documents.push({
    id: "secret",
    sourceId: "secret-source",
    kind: "rule",
    roles: ["profile"],
    text: "火星地质",
  });
  return new Knowledge(data);
}

test("token checked spans retain every original code point including tail and prefix allowance", () => {
  const text = "中文😀e\u0301𠀀".repeat(90) + "最后一条硬条件";
  const spans = chunkText(text, tokenCount, "prefix", 37);
  const covered = Array(text.length).fill(false);
  for (const s of spans) {
    assert.equal(s.text, text.slice(s.start, s.end));
    assert(s.tokens <= 37);
    assert(!/[\uDC00-\uDFFF]/.test(s.text[0]!));
    for (let i = s.start; i < s.end; i++) covered[i] = true;
  }
  assert(covered.every(Boolean));
  assert(spans.at(-1)!.text.endsWith("最后一条硬条件"));
  assert.deepEqual(chunkText("", tokenCount), []);
  assert.throws(() => chunkText("a", tokenCount, "large", 4), /prefix/);
});

test("long document tail is ranked once per parent, ACL filtered, and index rebuild uses cached batches", async () => {
  const k = corpus(),
    b = backend(),
    dir = directory();
  const built = await buildIndex(k, dir, signal(), undefined, b);
  assert(built.vectors > built.documents);
  const calls = b.calls;
  await buildIndex(k, dir, signal(), undefined, b);
  assert.equal(b.calls, calls);
  const vectors = new ExactVectors(dir, k.snapshotHash, b);
  const ranks = await vectors.rank("火星地质", ["long"], signal());
  assert.equal(ranks.length, 1);
  assert.equal(ranks[0]!.id, "long");
  assert(
    k.docs
      .find((d) => d.id === "long")!
      .text.slice(ranks[0]!.passage.start, ranks[0]!.passage.end)
      .includes("火星地质"),
  );
  const hits = await new Knowledge(k.data, vectors).search(
    "match",
    "火星地质",
    {},
    signal(),
  );
  assert(!hits.some((h) => h.evidence.id === "secret"));
  assert(hits.some((h) => h.evidence.id === "long" && h.passage));
  const long = hits.find((h) => h.evidence.id === "long")!;
  assert.equal(long.excerpt.complete, false);
  assert(long.evidence.text.includes("火星地质"));
  assert(long.evidence.text.length <= 4001);
  assert.deepEqual(await vectors.rank("火星地质", [], signal()), []);
});

test("cancelled index replacement preserves published manifest and corrupted vector bytes are rejected", async () => {
  const k = corpus(),
    dir = directory(),
    b = backend();
  const built = await buildIndex(k, dir, signal(), undefined, b);
  const before = readFileSync(resolve(dir, "manifest.json"), "utf8");
  const controller = new AbortController();
  await assert.rejects(
    buildIndex(k, dir, controller.signal, () => controller.abort(), b),
  );
  assert.equal(readFileSync(resolve(dir, "manifest.json"), "utf8"), before);
  const path = resolve(dir, built.manifest.vectorFile),
    bytes = readFileSync(path);
  bytes[0] = bytes[0]! ^ 1;
  writeFileSync(path, bytes);
  assert.throws(() => new ExactVectors(dir, k.snapshotHash, b), /Corrupt/);
});

test("invalid cached embeddings, model mismatch and legacy truncating indexes fail explicitly", async () => {
  const k = corpus(),
    dir = directory(),
    b = backend();
  await buildIndex(k, dir, signal(), undefined, b);
  assert.throws(
    () =>
      new ExactVectors(dir, k.snapshotHash, {
        ...b,
        options: { ...b.options, queryPrefix: "changed" },
      }),
    /mismatch/,
  );
  const cache = resolve(
    dir,
    "batches",
    readdirSync(resolve(dir, "batches"))[0]!,
  );
  writeFileSync(cache, JSON.stringify({ vectors: [[0, 0]], tokens: null }));
  await assert.rejects(
    buildIndex(k, dir, signal(), undefined, b),
    /Invalid embedding/,
  );
  writeFileSync(resolve(dir, "manifest.json"), JSON.stringify({ version: 1 }));
  assert.throws(() => new ExactVectors(dir, k.snapshotHash, b), /Legacy/);
});

function seed(
  s: Store,
  user = "owner",
  ns = "shared",
  key = "key",
  value = "value",
  date = "2026-01-01T00:00:00Z",
  retracted = 0,
  expires: string | null = null,
) {
  s.db
    .prepare(
      "INSERT INTO memories(user_id,namespace,key,value,version,source_run,evidence,updated_at,retracted,expires_at) VALUES(?,?,?,?,1,'fixture','[]',?,?,?)",
    )
    .run(user, ns, key, value, date, retracted, expires);
}
test("task memory recalls old facts beyond forty heads with role/user ACL before ranking", () => {
  const s = new Store(resolve(directory(), "memory.sqlite"));
  try {
    seed(s, "owner", "shared", "old", "希望从事火星地质研究");
    for (let i = 0; i < 65; i++)
      seed(
        s,
        "owner",
        "shared",
        `recent-${i}`,
        "普通资料",
        "2026-09-01T00:00:00Z",
      );
    seed(s, "owner", "profile", "private", "火星地质秘密");
    seed(s, "another", "shared", "private", "火星地质秘密");
    const found = s.recallMemories("owner", "match", { query: "火星地质" });
    assert.deepEqual(
      found.items.map((r) => r.key),
      ["old"],
    );
    assert.equal(found.totalAvailable, 66);
    assert.equal(
      s.memoryContext("owner", "match", "火星地质").items[0]!.key,
      "old",
    );
    assert.equal(
      s.memoryContext("owner", "match", "完全没有命中").items.length,
      8,
    );
    const keys = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = s.recallMemories("owner", "match", { limit: 7, cursor });
      page.items.forEach((r) => {
        assert(!keys.has(r.key));
        keys.add(r.key);
      });
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    assert.equal(keys.size, 66);
  } finally {
    s.close();
  }
});

test("memory cursors bind user, role, query and version; inactive heads reveal no old value", () => {
  const s = new Store(resolve(directory(), "memory.sqlite"));
  try {
    seed(s, "owner", "shared", "a", "旧敏感秘密", undefined, 1);
    seed(
      s,
      "owner",
      "shared",
      "b",
      "过期敏感秘密",
      undefined,
      0,
      "2000-01-01T00:00:00Z",
    );
    seed(s, "owner", "shared", "c");
    seed(s, "owner", "shared", "d");
    assert.equal(s.recallMemories("owner", "match", {}).items.length, 2);
    const page = s.recallMemories("owner", "match", {
      limit: 1,
      includeInactive: true,
    });
    const cursor = page.nextCursor!;
    for (const [user, role, query] of [
      ["another", "match", ""],
      ["owner", "profile", ""],
      ["owner", "match", "different"],
    ] as const)
      assert.throws(
        () =>
          s.recallMemories(user, role, {
            cursor,
            query,
            includeInactive: true,
          }),
        /cursor/,
      );
    const inactive = s
      .recallMemories("owner", "match", { includeInactive: true })
      .items.filter((r) => r.state !== "active");
    assert(inactive.every((r) => r.value === "" && r.evidence === "[]"));
    assert.equal(
      s.recallMemories("owner", "match", {
        query: "敏感秘密",
        includeInactive: true,
      }).items.length,
      0,
    );
    s.db
      .prepare(
        "UPDATE memories SET version=2 WHERE user_id='owner' AND key='c'",
      )
      .run();
    assert.throws(
      () =>
        s.recallMemories("owner", "match", { cursor, includeInactive: true }),
      /snapshot/,
    );
    assert.throws(
      () => s.recallMemories("owner", "match", { cursor: "malformed" }),
      /cursor/,
    );
  } finally {
    s.close();
  }
});
