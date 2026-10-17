// Fault-injection at Runtime.model's durable response boundary, independent of
// graph checkpoint fixtures. No credentials or network.
import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { resolve } from "node:path";
import { Store } from "../../src/storage.js";
import { Runtime, EXECUTION_STATE_PREFIX } from "../../src/runtime.js";
import { DomainTools } from "../../src/tools.js";
import { Knowledge } from "../../src/retrieval.js";
import { loadDataset } from "../../src/data.js";
import { ROOT } from "../../src/config.js";
import { ReplayProvider } from "../../src/providers.js";
import { config } from "../test-config.js";
const [db, id, mode] = process.argv.slice(2);
if (!db || !id || !["crash", "recover"].includes(mode!))
  throw Error("Missing fixture arguments");
const store = new Store(db),
  run = store.run(id),
  knowledge = new Knowledge(
    loadDataset(resolve(ROOT, "data/synthetic/dataset.json")),
  );
const tools = new DomainTools(
  "profile",
  run,
  "profile",
  store,
  knowledge,
  [],
  new AbortController().signal,
);
const runtime = new Runtime(
  store,
  knowledge,
  new ReplayProvider(
    mode === "crash"
      ? [
          {
            reply: {
              message: { role: "assistant", content: "frozen response" },
              usage: { input: 10, output: 10, cachedInput: 0 },
              finishReason: "stop",
            },
          },
        ]
      : [],
  ),
  config(),
);
// Exercise the exact private model boundary; normal graph tests separately
// cover checkpoint scheduling and lease recovery.
(runtime as any).deadline = performance.now() + 20000;
const answer = await (runtime as any).model(
  run,
  "profile",
  [
    { role: "system", content: "profile" },
    { role: "user", content: "TASK_DATA frozen" },
  ],
  tools.definitions(),
  "expert:profile:turn:0",
  false,
  [],
  () => {
    if (mode === "recover")
      throw Error("Must not recompute advanced state for a received response");
    return tools.executionState();
  },
);
const stateMessage = answer.messages.find((m: any) =>
  m.content?.startsWith(EXECUTION_STATE_PREFIX),
);
assert.equal(
  JSON.parse(stateMessage.content.slice(EXECUTION_STATE_PREFIX.length))
    .questions[0].version,
  0,
);
assert.equal(answer.reply.message.content, "frozen response");
if (mode === "crash") {
  await tools.invoke("input_read", { source: "request" }, "request");
  await tools.invoke("resume_read", {}, "resume");
  const q = tools.executionState().questions[0]!;
  await tools.invoke(
    "clarification_update",
    {
      updates: [
        {
          questionId: q.questionId,
          expectedVersion: 0,
          status: "unanswered",
          claims: [],
          remaining: [q.questionText],
          reason: "保留未解决问题",
        },
      ],
    },
    "update",
  );
  writeSync(1, "STATE_ADVANCED");
  process.kill(process.pid, "SIGKILL");
}
store.close();
