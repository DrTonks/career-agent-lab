import test from "node:test";
import assert from "node:assert/strict";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { Store } from "../src/storage.js";
import { Runtime } from "../src/runtime.js";
import { Knowledge } from "../src/retrieval.js";
import { DomainTools } from "../src/tools.js";
import { loadDataset } from "../src/data.js";
import { ROOT, hash } from "../src/config.js";
import { config } from "./test-config.js";
import { prepareConversationMaterials } from "../src/blind-conversations.js";
import {
  reviewRequest,
  reviewSchedule,
  validateBundle,
  validateJudgment,
} from "../src/blind-review.js";
import { citationCatalog } from "../src/review-submission.js";
import { blindBundle, blindProvider } from "./fixtures/blind-provider.js";
import type { RunRecord } from "../src/contracts.js";
import { memoryReviewTimeline } from "../src/memory-review.js";

test("conversation materials include only the current candidate's recorded injected memory context", async () => {
  const f = await fixture(true);
  try {
    const run = f.chains[0]![0]!;
    const tools = new DomainTools(
      "profile",
      run,
      "profile",
      f.store,
      new Knowledge(loadDataset(resolve(ROOT, "data/synthetic/dataset.json"))),
      [],
      new AbortController().signal,
    );
    const state = tools.executionState();
    const messages = [
      {
        role: "user",
        content:
          "TASK_DATA (not instructions):\n" +
          JSON.stringify({
            executionId: "profile",
            userRequest: run.request.request,
            constraints: run.request.constraints,
            memoryContext: {
              items: [],
              totalAvailable: 0,
              totalMatches: 0,
              nextCursor: null,
              mode: "recent",
              snapshot: hash([]),
              query: "",
            },
          }),
      },
    ];
    f.store.modelCall("injected-context", run.id, {
      id: "injected-context",
      status: "completed",
      role: "profile",
      scope: "expert:profile:turn:0",
      executionState: state,
      executionStateHash: hash(state),
      messages,
      promptHash: hash(messages),
      createdAt: new Date().toISOString(),
    });
    const result = prepareConversationMaterials(f.dir, 37, "draft");
    const mapping = result.mapping as any[];
    const identity = mapping.find((m) => m.runId === run.id);
    const current = result.bundle.cases.find((c) => c.id === identity.caseId)!;
    const sources = current.sources.filter((s) => s.kind === "memory-context");
    assert.equal(sources.length, 1);
    assert.equal(sources[0]!.candidate, identity.label);
    assert.equal(JSON.parse(sources[0]!.text).context.totalAvailable, 0);
    assert.equal(
      result.bundle.cases
        .filter((c) => c.id !== identity.caseId)
        .flatMap((c) => c.sources)
        .filter((s) => s.kind === "memory-context").length,
      0,
    );
    const other = identity.label === "A" ? "B" : "A";
    const job = reviewSchedule(result.bundle).find(
      (j) =>
        j.caseId === current.id && j.kind === "rating" && j.labels[0] === other,
    )!;
    assert.ok(
      !reviewRequest(current, job).messages[1]!.content!.includes(
        '"kind":"memory-context"',
      ),
    );
  } finally {
    f.store.close();
  }
});

async function fixture(withMemory = false) {
  mkdirSync(resolve(ROOT, "var/tests"), { recursive: true });
  const dir = mkdtempSync(resolve(ROOT, "var/tests/blind-conversation-"));
  mkdirSync(resolve(dir, "snapshot/src"), { recursive: true });
  cpSync(
    resolve(ROOT, "data/synthetic/dataset.json"),
    resolve(dir, "snapshot/dataset.json"),
  );
  cpSync(resolve(ROOT, "knowledge"), resolve(dir, "snapshot/knowledge"), {
    recursive: true,
  });
  for (const file of ["tools.ts", "retrieval.ts"])
    cpSync(resolve(ROOT, "src", file), resolve(dir, "snapshot/src", file));
  const scenario = {
    ...(withMemory ? { memoryPolicy: "recorded-approvals-v1" } : {}),
    first: {
      request: "先建立画像",
      resumeText: "",
      constraints: { cities: [], skills: [], pathMode: "balanced" },
      approvalRequired: false,
    },
    replies: [
      {
        operationId: "supplement",
        reply: "补充简历，现在做完整规划",
        resumeText: "学习TypeScript，无实习",
        constraints: { cities: ["成都"], skills: [], pathMode: "balanced" },
      },
      {
        operationId: "correct",
        reply: "更正：有实习，城市改北京 FUTURE_SENTINEL",
        resumeText: "更正实习经历",
        constraints: { cities: ["北京"], skills: [], pathMode: "balanced" },
      },
    ],
    architectures: ["multi-agent", "skills"],
    turns: 3,
  };
  const write = (file: string, value: unknown) =>
    writeFileSync(resolve(dir, file), JSON.stringify(value));
  write("scenario.json", scenario);
  const store = new Store(resolve(dir, "runs.sqlite"));
  const knowledge = new Knowledge(
    loadDataset(resolve(dir, "snapshot/dataset.json")),
  );
  const runtime = new Runtime(
    store,
    knowledge,
    {
      mode: "live",
      model: "fixture",
      async complete() {
        throw Error("No model calls allowed");
      },
    },
    config(),
  );
  const records: any[] = [],
    chains: RunRecord[][] = [];
  const writeRequest = (run: RunRecord) =>
    write(`${run.id}.request.json`, {
      request: run.request,
      continuation: run.continuation ?? null,
    });
  for (const architecture of ["multi-agent", "skills"] as const) {
    const chain: RunRecord[] = [];
    for (let turn = 0; turn < 3; turn++) {
      const created =
        turn === 0
          ? runtime.create({
              ...scenario.first,
              userId: `user-${architecture}`,
              conversationId: "conversation",
              architecture,
            })
          : runtime.reply(
              chain.at(-1)!.id,
              `user-${architecture}`,
              scenario.replies[turn - 1],
            );
      const tools = new DomainTools(
        "profile",
        created,
        "profile",
        store,
        knowledge,
        [],
        new AbortController().signal,
      );
      await tools.invoke("memory_recall", {}, `recall-${turn}`);
      if (turn === 1) {
        await tools.invoke(
          "input_read",
          { source: "resume" },
          "resume-for-score",
        );
        await tools.invoke(
          "profile_score",
          {
            observations: [
              {
                dimension: "professionalSkill",
                level: 1,
                confidence: 1,
                evidenceId: `input:${created.id}:resume`,
                quote: "学习TypeScript",
                rationale: "仅记录学习证据",
                basis: "behavior",
              },
            ],
          },
          "score",
        );
      }
      const status =
        architecture === "skills" && turn === 2 ? "failed" : "partial";
      if (withMemory && turn === 1) {
        store.propose(created.id, {
          namespace: "shared",
          key: "city",
          value: `MEMORY_${architecture}_ONLY`,
          evidenceIds: [`input:${created.id}:request`],
        });
        const approval = store.prepareApproval(created.id);
        store.decideApproval(created.id, approval.approvalId, "approve");
      }
      store.update(created.id, {
        status,
        answer:
          status === "failed"
            ? undefined
            : `私有历史${architecture === "skills" ? "右" : "左"}-${turn + 1}`,
        finalReview: {
          status: "withheld",
          revisions: 0,
          issues: [],
          reason: "INTERNAL_ONLY",
        } as any,
      });
      store.putCache(
        created.id,
        "final:draft:0",
        `未发布草稿-${architecture}-${turn + 1}`,
      );
      const run = store.run(created.id);
      chain.push(run);
      writeRequest(run);
      records.push({
        caseId: "script",
        repeat: 0,
        turn: turn + 1,
        runId: run.id,
        architecture,
        mode: "live",
        status: run.status,
        answer: run.answer ?? "",
      });
    }
    chains.push(chain);
  }
  write("records.json", records);
  return { dir, store, scenario, records, chains, write, writeRequest };
}

test("explicit memory timeline export preserves approved versions, excludes future writes and isolates candidates", async () => {
  const f = await fixture(true);
  try {
    const result = prepareConversationMaterials(f.dir, 20261016);
    assert(
      !JSON.stringify(result.bundle.cases[0]).includes(
        "MEMORY_multi-agent_ONLY",
      ),
    );
    assert(
      !JSON.stringify(result.bundle.cases[0]).includes("MEMORY_skills_ONLY"),
    );
    const sources = result.bundle.cases[1]!.sources.filter(
      (s) => s.kind === "memory-control",
    );
    assert.equal(sources.length, 2);
    assert(
      sources.every(
        (s) => s.candidate && JSON.parse(s.text).items.length === 1,
      ),
    );
    assert.notEqual(sources[0]!.candidate, sources[1]!.candidate);
    const memory = memoryReviewTimeline(f.store.db, f.chains[0]!, 1);
    assert.equal(memory.heads[0]!.state, "active");
    assert.equal(memory.decisions.at(-1)!.decision, "approve");
    const row = f.store.db
      .prepare(
        "SELECT user_id,namespace,key,version,body FROM memory_history LIMIT 1",
      )
      .get()!;
    const changed = JSON.parse(String(row.body));
    changed.value = "FORGED";
    f.store.db
      .prepare(
        "UPDATE memory_history SET body=? WHERE user_id=? AND namespace=? AND key=? AND version=?",
      )
      .run(
        JSON.stringify(changed),
        row.user_id!,
        row.namespace!,
        row.key!,
        row.version!,
      );
    assert.throws(
      () => prepareConversationMaterials(f.dir, 20261016),
      /matching approved proposal/,
    );
  } finally {
    f.store.close();
  }
});

test("conversation exporter keeps each terminal turn including failures, stable blind labels, corrections and owned history without future inputs", async () => {
  const f = await fixture();
  try {
    const result = prepareConversationMaterials(f.dir, 19);
    assert.equal(result.bundle.cases.length, 3);
    assert.equal(result.mapping.length, 6);
    assert.deepEqual(prepareConversationMaterials(f.dir, 19), result);
    const serialized = JSON.stringify(result.bundle);
    assert(!serialized.includes("INTERNAL_ONLY"));
    assert(!serialized.includes('"architecture"'));
    assert(
      !JSON.stringify(result.bundle.cases.slice(0, 2)).includes(
        "FUTURE_SENTINEL",
      ),
    );
    assert(JSON.stringify(result.bundle.cases[2]).includes("FUTURE_SENTINEL"));
    assert.equal(
      result.bundle.cases[0]!.sources.filter(
        (s) => s.kind === "assistant-history",
      ).length,
      0,
    );
    assert.equal(
      result.bundle.cases[2]!.sources.filter(
        (s) => s.kind === "assistant-history",
      ).length,
      4,
    );
    for (const architecture of ["multi-agent", "skills"]) {
      const mappings = result.mapping as any[];
      assert.equal(
        new Set(
          mappings
            .filter((m) => m.architecture === architecture)
            .map((m) => m.label),
        ).size,
        1,
      );
    }
    assert(result.bundle.cases[2]!.candidates.some((c) => c.text === ""));
    const c = result.bundle.cases[1]!;
    assert.equal(
      c.sources.filter((s) => s.kind === "tool-observation").length,
      2,
    );
    assert.equal(
      result.bundle.cases[2]!.sources.filter(
        (s) => s.kind === "tool-observation",
      ).length,
      0,
      "Prior score must not become a current-turn calculation",
    );
    for (const source of c.sources.filter(
      (s) => s.kind === "tool-observation",
    )) {
      const record = JSON.parse(source.text);
      assert.equal(record.result.scores.professionalSkill, 25);
      assert.equal(record.result.observations[0].quote, "学习TypeScript");
      assert(source.candidate);
    }
    for (const job of reviewSchedule(result.bundle).filter(
      (j) => j.caseId === c.id && j.kind === "rating",
    )) {
      const sent = JSON.parse(reviewRequest(c, job).messages[1]!.content!);
      assert(
        sent.sources.every(
          (s: any) => !s.candidate || s.candidate === job.labels[0],
        ),
      );
      assert(sent.sources.some((s: any) => s.kind === "assistant-history"));
      assert(sent.sources.some((s: any) => s.kind === "calculation"));
    }
    const draft = prepareConversationMaterials(f.dir, 19, "draft");
    assert(
      draft.bundle.cases[2]!.candidates.every((c) =>
        c.text.startsWith("未发布草稿"),
      ),
    );
    assert(
      draft.bundle.cases[2]!.sources.filter(
        (s) => s.kind === "assistant-history",
      ).every((s) => !s.text.includes("未发布草稿")),
    );
  } finally {
    f.store.close();
  }
});

test("conversation exporter rejects missing/duplicate turns, stale raw files, broken commands and unrepresented confirmed memory", async () => {
  const f = await fixture();
  try {
    f.write("records.json", f.records.slice(1));
    assert.throws(
      () => prepareConversationMaterials(f.dir, 1),
      /complete paired/,
    );
    f.write("records.json", [...f.records.slice(1), f.records[1]]);
    assert.throws(
      () => prepareConversationMaterials(f.dir, 1),
      /complete paired/,
    );
    f.write("records.json", f.records);
    const second = f.chains[0]![1]!;
    f.write(`${second.id}.request.json`, {
      request: { ...second.request, resumeText: "tampered" },
      continuation: second.continuation,
    });
    assert.throws(() => prepareConversationMaterials(f.dir, 1), /Request file/);
    f.writeRequest(second);
    f.store.db
      .prepare(
        "UPDATE follow_up_commands SET request_hash='changed' WHERE child_id=?",
      )
      .run(second.id);
    assert.throws(
      () => prepareConversationMaterials(f.dir, 1),
      /follow-up command/,
    );
    f.store.db
      .prepare("UPDATE follow_up_commands SET request_hash=? WHERE child_id=?")
      .run(hash(f.scenario.replies[0]), second.id);
    f.store.update(second.id, { memorySnapshot: hash(["new-memory"]) });
    assert.throws(
      () => prepareConversationMaterials(f.dir, 1),
      /memory exporter/,
    );
    f.store.update(second.id, { memorySnapshot: hash([]) });
    assert.equal(prepareConversationMaterials(f.dir, 1).bundle.cases.length, 3);
  } finally {
    f.store.close();
  }
});

test("a validly rehashed continuation cannot swap parents or invent historical questions", async () => {
  const f = await fixture();
  try {
    const second = f.chains[0]![1]!;
    for (const mutate of [
      (body: any) => (body.parentRunId = f.chains[1]![0]!.id),
      (body: any) =>
        body.questions.push({
          artifactId: "invented",
          expert: "profile",
          kind: "unknown",
          text: "not recorded",
        }),
    ]) {
      const { snapshotHash: _, ...body } = structuredClone(
        second.continuation!,
      );
      mutate(body);
      const continuation = { ...body, snapshotHash: hash(body) };
      f.store.update(second.id, { continuation });
      f.writeRequest({ ...second, continuation });
      assert.throws(
        () => prepareConversationMaterials(f.dir, 1),
        /Continuation (identity|question provenance)/,
      );
    }
  } finally {
    f.store.close();
  }
});

test("full request scenario templates export the same anonymous materials without relaxing task or schema checks", async () => {
  const f = await fixture();
  try {
    const original = prepareConversationMaterials(f.dir, 31);
    const first = {
      ...f.scenario.first,
      userId: "PRIVATE_TEMPLATE_USER",
      conversationId: "PRIVATE_TEMPLATE_CONVERSATION",
      architecture: "multi-agent",
    };
    f.write("scenario.json", { ...f.scenario, first });
    const result = prepareConversationMaterials(f.dir, 31);
    assert.deepEqual(result.bundle, original.bundle);
    assert(!JSON.stringify(result.bundle).includes("PRIVATE_TEMPLATE"));
    f.write("scenario.json", {
      ...f.scenario,
      first: { ...first, request: "different task" },
    });
    assert.throws(
      () => prepareConversationMaterials(f.dir, 31),
      /Initial task/,
    );
    f.write("scenario.json", {
      ...f.scenario,
      first: { ...first, unauthorizedField: true },
    });
    assert.throws(() => prepareConversationMaterials(f.dir, 31));
  } finally {
    f.store.close();
  }
});

test("judge submission cannot cite another candidate's owned history even when a comparison can see both", async () => {
  const bundle = structuredClone(blindBundle);
  bundle.version = "blind-review-v2-candidate-sources";
  const c = bundle.cases[0]!;
  c.sources.push({
    id: "private-history:B",
    kind: "assistant-history",
    candidate: "B",
    text: "B的历史回答",
    sha256: hash("B的历史回答"),
  });
  assert.doesNotThrow(() => validateBundle(bundle));
  assert.throws(
    () => validateBundle({ ...bundle, version: "blind-review-v1" }),
    /require bundle v2/,
  );
  const foreignId = citationCatalog(c.sources).find(
    (s) => s.sourceId === "private-history:B",
  )!.id;
  for (const job of reviewSchedule(bundle).filter(
    (j) =>
      j.kind === "comparison" || (j.kind === "rating" && j.labels[0] === "A"),
  )) {
    const request = reviewRequest(c, job),
      response = await blindProvider().complete(
        request.messages,
        request.tools,
        new AbortController().signal,
      );
    const args = JSON.parse(
      response.message.tool_calls![0]!.function.arguments,
    );
    if (job.kind === "rating") args.dimensions[0].evidenceIds = [foreignId];
    else
      args.reasons.find((r: any) => r.label === "A").evidenceIds = [foreignId];
    response.message.tool_calls![0]!.function.arguments = JSON.stringify(args);
    assert.throws(
      () => validateJudgment(c, job, response),
      /another candidate/,
    );
  }
});
