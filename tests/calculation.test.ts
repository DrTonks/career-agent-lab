import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { resolve } from "node:path";
import { Store } from "../src/storage.js";
import { Runtime } from "../src/runtime.js";
import { DomainTools, DomainValidationError } from "../src/tools.js";
import { Knowledge } from "../src/retrieval.js";
import { loadDataset } from "../src/data.js";
import { ROOT } from "../src/config.js";
import { config } from "./test-config.js";
import {
  Request,
  type Artifact,
  type ModelProvider,
  type ModelReply,
  type Role,
} from "../src/contracts.js";
import { calculationEvidence, parseCalculation } from "../src/calculation.js";
const data = loadDataset(resolve(ROOT, "data/synthetic/dataset.json"));
const noModel: ModelProvider = {
  mode: "replay",
  model: "calculation-test",
  async complete() {
    throw Error("No model expected");
  },
};
const result = (artifact: Record<string, unknown>, evidenceIds: string[]) => ({
  status: "partial" as const,
  summary: "有限范围分析",
  evidenceIds,
  unknowns: [],
  conflicts: [],
  nextActions: [],
  artifact,
});
function setup(path = ":memory:") {
  const store = new Store(path),
    knowledge = new Knowledge(data);
  const run = new Runtime(store, knowledge, noModel, config()).create(
    Request.parse({
      userId: "calc-user",
      conversationId: "c",
      request: "分析",
      constraints: { minMonthlySalary: 90000 },
    }),
  );
  const tool = (role: Role, step: string = role, inputs: Artifact[] = []) =>
    new DomainTools(
      role,
      run,
      step,
      store,
      knowledge,
      inputs,
      new AbortController().signal,
    );
  return { store, knowledge, run, tool };
}
test("empty job search provides exact scoped calculation evidence without granting excluded job reads", async () => {
  const { store, tool } = setup();
  try {
    const t = tool("match"),
      r: any = await t.invoke(
        "jobs_search",
        { query: "前端", categoryIds: [], limit: 15 },
        "s",
      );
    assert.deepEqual(r.eligible, []);
    assert.deepEqual(r.uncertain, []);
    const body = parseCalculation(r.evidence);
    assert.equal(body.result.counts && (body.result.counts as any).eligible, 0);
    assert.equal(
      (body.result.appliedConstraints as any).minMonthlySalary,
      90000,
    );
    assert.equal((body.result.counts as any).beforeFilter, 24);
    assert.equal(
      [...t.seen.values()].filter((e) => e.kind === "job").length,
      0,
    );
    assert.throws(() => t.assertEvidence(["job:synthetic-1-1"]), /Unread/);
    await t.invoke(
      "expert_finish",
      result({ rankedJobs: [] }, [r.evidence.id]),
      "finish",
    );
    assert.equal(t.result?.status, "partial");
  } finally {
    store.close();
  }
});
test("calculation reads require matching run, attempt or explicit publication, plus an actual stored receipt", async () => {
  const { store, run, tool } = setup();
  try {
    const owner = tool("match"),
      r: any = await owner.invoke("jobs_search", { query: "前端" }, "s");
    await assert.rejects(
      tool("path").invoke("knowledge_read", { id: r.evidence.id }, "denied"),
      /outside/,
    );
    await assert.rejects(
      tool("match", "match@2" as Role).invoke(
        "knowledge_read",
        { id: r.evidence.id },
        "attempt",
      ),
      /outside/,
    );
    const artifact: Artifact = {
      id: `${run.id}:match`,
      runId: run.id,
      stepId: "match",
      expert: "match",
      version: 1,
      result: result({ rankedJobs: [] }, [r.evidence.id]),
      publishedEvidence: [r.evidence],
    };
    const downstream = tool("report", "report", [artifact]);
    assert.throws(() => downstream.assertEvidence([r.evidence.id]), /Unread/);
    await downstream.invoke(
      "knowledge_read",
      { id: r.evidence.id, maxChars: 6000 },
      "read",
    );
    downstream.assertEvidence([r.evidence.id]);
    const forged = calculationEvidence({
      ...parseCalculation(r.evidence),
      result: { counts: { eligible: 999 } },
    });
    await assert.rejects(
      tool("report", "report", [
        { ...artifact, publishedEvidence: [forged] },
      ]).invoke("knowledge_read", { id: forged.id }, "forged"),
      /not available/,
    );
    const altered = { ...r.evidence, text: "invented counts" };
    await assert.rejects(
      tool("report", "report", [
        { ...artifact, publishedEvidence: [altered] },
      ]).invoke("knowledge_read", { id: r.evidence.id }, "altered"),
      /stored receipt/,
    );
    const otherRun = new Runtime(
      store,
      new Knowledge(data),
      noModel,
      config(),
    ).create(
      Request.parse({ userId: "other", conversationId: "c", request: "x" }),
    );
    const stranger = new DomainTools(
      "report",
      otherRun,
      "report",
      store,
      new Knowledge(data),
      [artifact],
      new AbortController().signal,
    );
    await assert.rejects(
      stranger.invoke("knowledge_read", { id: r.evidence.id }, "cross-run"),
      /not available/,
    );
  } finally {
    store.close();
  }
});
test("route reference resolves exact verified nodes and rejects branch joins with actionable feedback", async () => {
  const { store, tool } = setup();
  try {
    const t = tool("path"),
      search: any = await t.invoke(
        "graph_paths",
        { start: "frontend-junior", target: "qa-junior" },
        "g",
      );
    const route = search.paths[0];
    assert.equal(parseCalculation(route.routeEvidence).tool, "graph_route");
    await assert.rejects(
      t.invoke(
        "expert_finish",
        result(
          {
            paths: [
              {
                nodes: ["frontend-junior", "frontend-mid", "qa-junior"],
                actions: ["学习与验证"],
              },
            ],
          },
          [route.routeId],
        ),
        "bad",
      ),
      (e: unknown) => {
        assert(e instanceof DomainValidationError);
        assert.equal(e.feedback.code, "invalid_graph_edge");
        assert.deepEqual(e.feedback.invalidEdge, {
          source: "frontend-mid",
          target: "qa-junior",
        });
        assert(
          (e.feedback.validRoutes as any[]).some(
            (r) => r.routeId === route.routeId,
          ),
        );
        return true;
      },
    );
    await assert.rejects(
      t.invoke(
        "expert_finish",
        result(
          {
            paths: [
              {
                routeId: route.routeId,
                nodes: ["frontend-junior", "frontend-mid"],
                actions: ["验证"],
              },
            ],
          },
          [route.routeId],
        ),
        "mismatch",
      ),
      /do not match/,
    );
    await t.invoke(
      "expert_finish",
      result(
        {
          paths: [
            { routeId: route.routeId, actions: ["补充测试作品并评估技能差距"] },
          ],
        },
        [route.routeId],
      ),
      "good",
    );
    assert.deepEqual((t.result!.artifact.paths as any[])[0].nodes, [
      "frontend-junior",
      "qa-junior",
    ]);
  } finally {
    store.close();
  }
});
test("a published route requires reading its nodes; unrelated calculations cannot act as routes or personal scores", async () => {
  const { store, run, tool } = setup();
  try {
    const origin = tool("path"),
      s: any = await origin.invoke(
        "graph_paths",
        { start: "frontend-junior", target: "qa-junior" },
        "g",
      ),
      route = s.paths[0];
    const artifact: Artifact = {
      id: `${run.id}:path`,
      runId: run.id,
      stepId: "path",
      expert: "path",
      version: 1,
      result: result({ paths: [] }, [route.routeId]),
      publishedEvidence: [route.routeEvidence],
    };
    const consumer = tool("path", "path-next" as Role, [artifact]);
    await consumer.invoke(
      "knowledge_read",
      { id: route.routeId, maxChars: 200 },
      "head",
    );
    await assert.rejects(
      consumer.invoke(
        "expert_finish",
        result({ paths: [{ routeId: route.routeId, actions: ["验证"] }] }, [
          route.routeId,
        ]),
        "unread",
      ),
      /Read the route nodes/,
    );
    await consumer.invoke(
      "knowledge_read",
      { id: route.routeId, maxChars: 6000 },
      "body",
    );
    await consumer.invoke(
      "expert_finish",
      result({ paths: [{ routeId: route.routeId, actions: ["验证"] }] }, [
        route.routeId,
      ]),
      "ok",
    );
    const profile = tool("profile");
    profile.remember(route.routeEvidence);
    await assert.rejects(
      profile.invoke(
        "profile_score",
        {
          observations: [
            {
              dimension: "learning",
              level: 2,
              confidence: 1,
              evidenceId: route.routeId,
              quote: "frontend-junior",
              basis: "behavior",
              rationale: "invalid personal basis",
            },
          ],
        },
        "score",
      ),
      /user-source/,
    );
    const matcher = tool("match"),
      jobs: any = await matcher.invoke(
        "jobs_search",
        { query: "前端" },
        "jobs",
      );
    const wrong = tool("path", "path-wrong" as Role, [
      { ...artifact, expert: "match", publishedEvidence: [jobs.evidence] },
    ]);
    await wrong.invoke(
      "knowledge_read",
      { id: jobs.evidence.id, maxChars: 6000 },
      "read",
    );
    await assert.rejects(
      wrong.invoke(
        "expert_finish",
        result({ paths: [{ routeId: jobs.evidence.id, actions: ["验证"] }] }, [
          jobs.evidence.id,
        ]),
        "wrong",
      ),
      /Expected a verified graph route/,
    );
  } finally {
    store.close();
  }
});
test("calculation identity and cached replay survive closing the store, without duplicating sources", async () => {
  mkdirSync(resolve(ROOT, "var/tests"), { recursive: true });
  const file = resolve(
    mkdtempSync(resolve(ROOT, "var/tests/calculation-")),
    "runs.sqlite",
  );
  const { store, run, tool } = setup(file);
  const first: any = await tool("match").invoke(
    "jobs_search",
    { query: "前端" },
    "a",
  );
  store.close();
  const reopened = new Store(file);
  try {
    const t = new DomainTools(
      "match",
      reopened.run(run.id),
      "match",
      reopened,
      new Knowledge(data),
      [],
      new AbortController().signal,
    );
    const second: any = await t.invoke("jobs_search", { query: "前端" }, "b");
    assert.deepEqual(second, first);
    const rows = reopened.db
      .prepare(
        "select key from tool_cache where run_id=? and key like 'calculation-source:%'",
      )
      .all(run.id);
    assert.equal(rows.length, 1);
    assert.equal(
      (
        reopened
          .events(run.id)
          .filter((e) => e.type === "tool.completed")
          .at(-1)!.payload as any
      ).replayed,
      true,
    );
    assert.throws(
      () =>
        parseCalculation({
          ...first.evidence,
          text: first.evidence.text + " ",
        }),
      /identity mismatch/,
    );
  } finally {
    reopened.close();
  }
});
test("failure after calculation persistence but before tool receipt recomputes the same source", async () => {
  const { store, tool } = setup();
  try {
    const put = store.putCache.bind(store);
    let interrupt = true;
    store.putCache = (id, key, value) => {
      put(id, key, value);
      if (interrupt && key.startsWith("calculation-source:")) {
        interrupt = false;
        throw Error("injected receipt window");
      }
    };
    await assert.rejects(
      tool("match").invoke("jobs_search", { query: "前端" }, "interrupted"),
      /injected receipt/,
    );
    const persisted = store.db
      .prepare(
        "select result from tool_cache where key like 'calculation-source:%'",
      )
      .all();
    assert.equal(persisted.length, 1);
    const source = JSON.parse(String(persisted[0]!.result));
    const done: any = await tool("match").invoke(
      "jobs_search",
      { query: "前端" },
      "recover",
    );
    assert.deepEqual(done.evidence, source);
    assert.equal(
      store.db
        .prepare(
          "select count(*) n from tool_cache where key like 'calculation-source:%'",
        )
        .get()!.n,
      1,
    );
  } finally {
    store.close();
  }
});
test("cancellation after retrieval prevents calculation publication", async () => {
  const { store, run, knowledge } = setup();
  const controller = new AbortController();
  const search = knowledge.search.bind(knowledge);
  knowledge.search = async (...args) => {
    const hits = await search(...args);
    controller.abort();
    return hits;
  };
  try {
    const t = new DomainTools(
      "match",
      run,
      "match",
      store,
      knowledge,
      [],
      controller.signal,
    );
    await assert.rejects(t.invoke("jobs_search", { query: "前端" }, "cancel"));
    assert.equal(
      store.db
        .prepare(
          "select count(*) n from tool_cache where key like 'calculation-source:%'",
        )
        .get()!.n,
      0,
    );
    assert.equal(t.result, undefined);
  } finally {
    store.close();
  }
});
for (const architecture of ["multi-agent", "skills"] as const)
  test(`${architecture}: exact edge feedback reaches the model and a route reference repairs the submission`, async () => {
    const store = new Store(":memory:");
    let turn = 0,
      routeId = "";
    const call = (name: string, args: unknown): ModelReply => ({
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: `c${turn}`,
            type: "function",
            function: { name, arguments: JSON.stringify(args) },
          },
        ],
      },
      finishReason: "tool_calls",
      usage: { input: 10, output: 10, cachedInput: 0 },
    });
    const provider: ModelProvider = {
      mode: "replay",
      model: "route-feedback",
      async complete(messages, defs) {
        if (defs.some((t) => t.function.name === "plan_submit"))
          return call("plan_submit", {
            rationale: "路径",
            steps: [
              {
                id: "path",
                expert: "path",
                objective: "验证转岗",
                dependsOn: [],
              },
            ],
          });
        if (defs.some((t) => t.function.name === "expert_finish")) {
          turn++;
          if (turn === 1)
            return call("graph_paths", {
              start: "frontend-junior",
              target: "qa-junior",
            });
          if (turn === 2) {
            routeId = JSON.parse(messages.at(-1)!.content!).paths[0].routeId;
            return call(
              "expert_finish",
              result(
                {
                  paths: [
                    {
                      nodes: ["frontend-junior", "frontend-mid", "qa-junior"],
                      actions: ["错误分支"],
                    },
                  ],
                },
                [routeId],
              ),
            );
          }
          const feedback = JSON.parse(messages.at(-1)!.content!);
          assert.equal(feedback.code, "invalid_graph_edge");
          assert.equal(feedback.invalidEdge.source, "frontend-mid");
          assert(feedback.validRoutes.some((r: any) => r.routeId === routeId));
          return call(
            "expert_finish",
            result({ paths: [{ routeId, actions: ["验证作品和前置技能"] }] }, [
              routeId,
            ]),
          );
        }
        return {
          message: { role: "assistant", content: "已生成有来源的条件路径。" },
          finishReason: "stop",
          usage: { input: 10, output: 10, cachedInput: 0 },
        };
      },
    };
    try {
      const rt = new Runtime(store, new Knowledge(data), provider, config());
      const r = rt.create(
        Request.parse({
          userId: "u",
          conversationId: "c",
          request: "转岗",
          architecture,
        }),
      );
      const done = await rt.execute(r.id, "u");
      assert.equal(done.status, "partial", done.error);
      assert.equal(turn, 3);
      assert.equal(store.modelCalls(r.id).length, 5);
      const artifact = store.artifacts(r.id)[0]!;
      assert.deepEqual((artifact.result.artifact.paths as any[])[0].nodes, [
        "frontend-junior",
        "qa-junior",
      ]);
      assert(artifact.publishedEvidence?.some((e) => e.id === routeId));
    } finally {
      store.close();
    }
  });
