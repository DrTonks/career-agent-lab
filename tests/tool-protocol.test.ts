import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { mkdirSync, mkdtempSync } from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { Runtime } from "../src/runtime.js";
import { Store } from "../src/storage.js";
import {
  Request,
  type ModelProvider,
  type ModelReply,
} from "../src/contracts.js";
import { Knowledge } from "../src/retrieval.js";
import { loadDataset } from "../src/data.js";
import { config, ROOT } from "../src/config.js";
import { reviewProvider } from "./fixtures/final-review-provider.js";
import { runMetrics } from "../src/evaluation.js";
import { malformedProvider } from "./fixtures/tool-protocol-provider.js";
const data = loadDataset(resolve(ROOT, "data/synthetic/dataset.json"));

for (const architecture of ["multi-agent", "skills"] as const)
  for (const boundary of ["response", "feedback"]) {
    test(`${architecture}: actual kill after invalid ${boundary} retains rejection count and commits each feedback once`, async () => {
      mkdirSync(resolve(ROOT, "var/tests"), { recursive: true });
      const db = resolve(
        mkdtempSync(resolve(ROOT, "var/tests/tool-protocol-")),
        "runs.sqlite",
      );
      let store = new Store(db);
      const cfg = {
        ...config(),
        finalReview: "off" as const,
        leaseTtlMs: 1500,
      };
      const run = new Runtime(
        store,
        new Knowledge(data),
        malformedProvider(),
        cfg,
      ).create(
        Request.parse({
          userId: "protocol-process",
          conversationId: "c",
          request: "画像",
          architecture,
        }),
      );
      store.close();
      const child = spawn(
        process.execPath,
        [
          resolve(ROOT, "dist/tests/fixtures/tool-protocol-worker.js"),
          db,
          run.id,
          run.request.userId,
          boundary,
        ],
        { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
      );
      let stderr = "";
      child.stderr.on("data", (b) => {
        stderr += String(b);
      });
      const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
      const [code] = await once(child, "exit");
      clearTimeout(timer);
      store = new Store(db);
      try {
        assert.notEqual(code, 0, stderr);
        assert.equal(store.modelCalls(run.id).length, 2, stderr);
        assert.equal(
          store
            .events(run.id)
            .filter((e) => e.type === "tool.arguments_rejected").length,
          boundary === "response" ? 0 : 1,
        );
        const lease = store.db
          .prepare("SELECT expires FROM leases WHERE resource=?")
          .get(run.id)!;
        await delay(Math.max(1, Number(lease.expires) - Date.now() + 60));
        let resumedExpertCalls = 0;
        const base = malformedProvider();
        const provider: ModelProvider = {
          ...base,
          async complete(...args) {
            if (args[1].some((t) => t.function.name === "expert_finish"))
              resumedExpertCalls++;
            return base.complete(...args);
          },
        };
        const done = await new Runtime(
          store,
          new Knowledge(data),
          provider,
          cfg,
        ).execute(run.id, run.request.userId);
        assert.equal(done.status, "failed");
        assert.equal(resumedExpertCalls, 2);
        assert.equal(
          store.artifacts(run.id)[0]!.failure?.code,
          "model_protocol",
        );
        assert.equal(store.artifactHistory(run.id).length, 1);
        const events = store
          .events(run.id)
          .filter((e) => e.type === "tool.arguments_rejected");
        assert.deepEqual(
          events.map((e) => (e.payload as any).identicalResponses),
          [1, 2, 3],
        );
        assert.equal(
          store
            .modelCalls(run.id)
            .filter((c) => String(c.scope).startsWith("expert:profile:turn:"))
            .length,
          3,
        );
        assert.equal(runMetrics(store, run.id).toolArgumentFailures, 3);
      } finally {
        store.close();
      }
    });
  }

for (const architecture of ["multi-agent", "skills"] as const)
  for (const repair of [false, true]) {
    test(`${architecture}: identical malformed arguments ${repair ? "can be corrected before the third response" : "stop without whole-expert retry and remain auditable"}`, async () => {
      const store = new Store(":memory:");
      let attempts = 0;
      const base = reviewProvider();
      const provider: ModelProvider = {
        ...base,
        model: "tool-protocol-fixture",
        async complete(messages, tools, ...rest) {
          if (tools.some((t) => t.function.name === "expert_finish")) {
            attempts++;
            if (attempts > 1) {
              const feedback = messages
                .filter((m) => m.role === "tool")
                .map((m) => {
                  try {
                    return JSON.parse(m.content!);
                  } catch {
                    return {};
                  }
                })
                .findLast((x) => x.code === "invalid_tool_json");
              assert(feedback?.instruction.includes("重新构建"));
              assert.equal(feedback.identicalResponses, attempts - 1);
            }
            if (!repair || attempts < 3)
              return {
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: `invalid-${attempts}`,
                      type: "function",
                      function: {
                        name: "expert_finish",
                        arguments: '{"status":"needs_input"',
                      },
                    },
                  ],
                },
                usage: { input: 10, output: 10, cachedInput: 0 },
                finishReason: "tool_calls",
              } as ModelReply;
          }
          if (!tools.length)
            return {
              message: { role: "assistant", content: "状态说明" },
              usage: { input: 10, output: 10, cachedInput: 0 },
              finishReason: "stop",
            };
          return base.complete(messages, tools, ...rest);
        },
      };
      try {
        const runtime = new Runtime(store, new Knowledge(data), provider, {
          ...config(),
          finalReview: "off",
        });
        const run = runtime.create(
          Request.parse({
            userId: "protocol-user",
            conversationId: "c",
            request: "画像",
            architecture,
          }),
        );
        const done = await runtime.execute(run.id, run.request.userId);
        assert.equal(attempts, 3);
        const artifact = store.artifacts(run.id)[0]!;
        if (repair) assert.equal(artifact.result.status, "needs_input");
        else {
          assert.equal(artifact.failure?.code, "model_protocol");
          assert.equal(artifact.failure?.retryable, false);
          assert.equal(done.status, "failed");
        }
        assert.equal(store.artifactHistory(run.id).length, 1);
        const invalid = store
          .events(run.id)
          .filter((e) => e.type === "tool.arguments_rejected");
        assert.equal(invalid.length, repair ? 2 : 3);
        assert.equal(
          runMetrics(store, run.id).toolArgumentFailures,
          invalid.length,
        );
        assert.equal(
          store
            .events(run.id)
            .filter(
              (e) =>
                e.type === "tool.started" &&
                (e.payload as any).name === "expert_finish",
            ).length,
          repair ? 1 : 0,
        );
        const calls = store
          .modelCalls(run.id)
          .filter((c) => String(c.scope).startsWith("expert:profile:turn:"));
        assert.equal(calls.length, 3);
        assert.equal(
          (calls[0]!.response as any).tool_calls[0].function.arguments,
          '{"status":"needs_input"',
        );
      } finally {
        store.close();
      }
    });
  }
