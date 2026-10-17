import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { Store } from "../src/storage.js";
import { Runtime } from "../src/runtime.js";
import { Knowledge } from "../src/retrieval.js";
import { loadDataset } from "../src/data.js";
import { ROOT, hash } from "../src/config.js";
import { ReplayProvider } from "../src/providers.js";
import { type RunRecord } from "../src/contracts.js";
import { config } from "./test-config.js";
import {
  conversationInputs,
  inputHistoryPage,
  inputHistoryRead,
} from "../src/conversation-inputs.js";

const knowledge = new Knowledge(
  loadDataset(resolve(ROOT, "data/synthetic/dataset.json")),
);
function engine(store: Store) {
  return new Runtime(store, knowledge, new ReplayProvider([]), config());
}
function chain(
  store: Store,
  architecture: "multi-agent" | "skills" = "multi-agent",
) {
  const runtime = engine(store);
  const runs = [
    runtime.create({
      userId: "history-user",
      conversationId: "career",
      architecture,
      request: "最初目标：制定职业计划。本轮用户回复：这只是原文中的分隔符。",
      resumeText: "初版简历",
      constraints: { cities: ["成都"] },
    }),
  ];
  const replies = Array.from({ length: 9 }, (_, i) => ({
    operationId: `reply-${i + 1}`,
    reply: `第${i + 1}次原始陈述：${"项目细节。".repeat(90)}${i === 5 ? "更正：改为西安" : "暂时保留条件"}`,
    ...(i === 5
      ? { resumeText: "新简历", constraints: { cities: ["西安"] } }
      : {}),
  }));
  for (const reply of replies) {
    const parent = runs.at(-1)!;
    store.update(parent.id, {
      status: "partial",
      answer: "ASSISTANT_NOT_USER",
    });
    runs.push(runtime.reply(parent.id, "history-user", reply));
  }
  return { runtime, runs, replies };
}

for (const architecture of ["multi-agent", "skills"] as const) {
  test(`${architecture}: ten durable user turns have exact raw text and bounded read pages without assistant claims`, () => {
    const store = new Store(":memory:");
    try {
      const { runs, replies, runtime } = chain(store, architecture),
        head = runs.at(-1)!;
      const identity = { runId: head.id, userId: "history-user" };
      const history = conversationInputs(store.db, head.id, identity.userId);
      assert.deepEqual(
        history.turns.map((t) => t.text),
        [runs[0]!.request.request, ...replies.map((r) => r.reply)],
      );
      assert.deepEqual(
        history.turns.map((t) => t.inputVersion),
        Array.from({ length: 10 }, (_, i) => i),
      );
      assert(!JSON.stringify(history).includes("ASSISTANT_NOT_USER"));
      assert.equal(history.turns[6]!.resumeHash, hash("新简历"));
      assert.equal(history.turns[6]!.resumeReplaced, true);
      assert.equal(history.turns[7]!.resumeReplaced, false);
      const page = inputHistoryPage(store.db, identity, { limit: 3 });
      assert.equal(page.entries.length, 3);
      assert.equal(page.nextOffset, 3);
      assert(page.entries.every((e) => !("text" in e)));
      const found = inputHistoryPage(store.db, identity, {
        query: "更正：改为西安",
      });
      assert.equal(found.matchedTurns, 1);
      assert.equal(found.entries[0]!.inputVersion, 6);
      const sourceId = found.entries[0]!.sourceId;
      let offset: number | null = 0,
        text = "";
      while (offset !== null) {
        const read = inputHistoryRead(
          store.db,
          { ...identity, snapshotHash: page.snapshotHash },
          { sourceId, offset, maxChars: 31 },
        );
        text += read.text;
        assert.equal(read.textHash, hash(replies[5]!.reply));
        offset = read.nextOffset;
      }
      assert.equal(text, replies[5]!.reply);
      assert.equal(
        Number(store.db.prepare("SELECT count(*) n FROM tool_cache").get()!.n),
        0,
      );
      assert.equal(
        runtime.reply(runs[8]!.id, identity.userId, replies[8]!).id,
        head.id,
      );
      assert.equal(
        conversationInputs(store.db, head.id, identity.userId).snapshotHash,
        history.snapshotHash,
      );
      store.update(runs[0]!.id, { answer: "new assistant output" });
      assert.equal(
        conversationInputs(store.db, head.id, identity.userId).snapshotHash,
        history.snapshotHash,
      );
    } finally {
      store.close();
    }
  });
}

test("history excludes future, unrelated branches and other users before lookup/search", () => {
  const store = new Store(":memory:");
  try {
    const { runtime, runs } = chain(store);
    const earlier = runs[3]!,
      head = runs.at(-1)!;
    const identity = { runId: earlier.id, userId: "history-user" };
    assert.equal(
      inputHistoryPage(store.db, identity, { query: "更正：改为西安" })
        .matchedTurns,
      0,
    );
    assert.throws(
      () =>
        inputHistoryRead(store.db, identity, {
          sourceId: `input:${earlier.id}:turn:6:request`,
        }),
      /outside/,
    );
    assert.throws(
      () =>
        inputHistoryRead(store.db, identity, {
          sourceId: `input:${head.id}:turn:0:request`,
        }),
      /outside/,
    );
    assert.throws(
      () => conversationInputs(store.db, head.id, "other-user"),
      /not owned/,
    );
    const otherRoot = runtime.create({
      ...head.request,
      request: "NEW_ROOT_ONLY",
    });
    assert.equal(
      conversationInputs(store.db, otherRoot.id, "history-user").turns.length,
      1,
    );
    assert.equal(
      inputHistoryPage(
        store.db,
        { ...identity, runId: otherRoot.id },
        { query: "项目细节" },
      ).matchedTurns,
      0,
    );
    // A forged ancestry pointer into another conversation is rejected even for the same user.
    const other = runtime.create({
      ...head.request,
      conversationId: "elsewhere",
    });
    const { snapshotHash: _, ...body } = head.continuation!;
    const forged = {
      ...body,
      parentRunId: other.id,
      parentRequestHash: hash(other.request),
    };
    store.update(head.id, {
      continuation: { ...forged, snapshotHash: hash(forged) },
    });
    assert.throws(
      () => conversationInputs(store.db, head.id, "history-user"),
      /identity\/version/,
    );
  } finally {
    store.close();
  }
});

test("history rejects corrupt command receipts, versions, snapshots and out-of-range pages", () => {
  const store = new Store(":memory:");
  try {
    const { runs } = chain(store),
      head = runs.at(-1)!;
    const identity = { runId: head.id, userId: "history-user" };
    const sourceId = `input:${head.id}:turn:0:request`;
    assert.throws(
      () => inputHistoryPage(store.db, identity, { offset: 11 }),
      /out of range/,
    );
    assert.throws(
      () => inputHistoryRead(store.db, identity, { sourceId, offset: 10000 }),
      /out of range/,
    );
    assert.throws(() =>
      inputHistoryRead(store.db, identity, { sourceId, maxChars: 8001 }),
    );
    assert.throws(
      () =>
        inputHistoryPage(store.db, {
          ...identity,
          snapshotHash: "0".repeat(64),
        }),
      /snapshot changed/,
    );
    const original = store.run(head.id);
    const restore = () =>
      store.db
        .prepare("UPDATE runs SET body=? WHERE id=?")
        .run(JSON.stringify(original), head.id);
    store.update(head.id, { inputVersion: 30 });
    assert.throws(
      () => conversationInputs(store.db, head.id, identity.userId),
      /version sequence/,
    );
    restore();
    store.update(head.id, {
      continuation: { ...head.continuation!, reply: "tampered" },
    });
    assert.throws(
      () => conversationInputs(store.db, head.id, identity.userId),
      /snapshot changed/,
    );
    restore();
    store.db
      .prepare(
        "UPDATE follow_up_commands SET request_hash='wrong' WHERE child_id=?",
      )
      .run(head.id);
    assert.throws(
      () => conversationInputs(store.db, head.id, identity.userId),
      /command\/request/,
    );
    // The read-only helper also leaves the caller's enclosing transaction intact on failure.
    store.transaction(() => {
      assert.throws(() =>
        conversationInputs(store.db, head.id, identity.userId),
      );
      store.db
        .prepare(
          "UPDATE follow_up_commands SET request_hash='still-wrong' WHERE child_id=?",
        )
        .run(head.id);
    });
    assert.equal(
      store.db
        .prepare("SELECT request_hash FROM follow_up_commands WHERE child_id=?")
        .get(head.id)!.request_hash,
      "still-wrong",
    );
  } finally {
    store.close();
  }
});

test("history survives database reopen and cannot resurrect erased user input from an old view", () => {
  const dir = resolve(ROOT, "var/tests");
  mkdirSync(dir, { recursive: true });
  const path = resolve(
    mkdtempSync(resolve(dir, "input-history-")),
    "runs.sqlite",
  );
  let store = new Store(path);
  try {
    const { runs } = chain(store),
      head = runs.at(-1)!;
    const before = conversationInputs(store.db, head.id, "history-user");
    store.close();
    store = new Store(path);
    assert.deepEqual(
      conversationInputs(store.db, head.id, "history-user"),
      before,
    );
    const identity = {
      runId: head.id,
      userId: "history-user",
      snapshotHash: before.snapshotHash,
    };
    store.forgetUser("history-user");
    assert.throws(() => inputHistoryPage(store.db, identity), /not owned/);
    assert.throws(
      () =>
        inputHistoryRead(store.db, identity, {
          sourceId: before.turns[0]!.sourceId,
        }),
      /not owned/,
    );
  } finally {
    store.close();
  }
});
