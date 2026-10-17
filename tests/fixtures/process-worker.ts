// Intentionally terminated by process.test.ts at durable commit boundaries.
// This worker only uses explicit replay; it never loads credentials or calls a network.
import { Store } from "../../src/storage.js";
import { Runtime } from "../../src/runtime.js";
import { Knowledge } from "../../src/retrieval.js";
import { ReplayProvider } from "../../src/providers.js";
import { loadDataset } from "../../src/data.js";
import { ROOT } from "../../src/config.js";
import { config } from "../test-config.js";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import type { ModelProvider } from "../../src/contracts.js";
import { SqliteSaver } from "../../src/checkpointer.js";

const [db, id, user, mode, approvalId] = process.argv.slice(2);
if (!db || !id || !user || !mode) throw new Error("Missing worker arguments");
const store = new Store(db),
  cfg = { ...config(), leaseTtlMs: 1500 };
if (mode === "hold") {
  store.lease(id, "live-child-worker", cfg.leaseTtlMs);
  setInterval(
    () => store.renewLease(id, "live-child-worker", cfg.leaseTtlMs),
    200,
  );
  process.stdout.write("LEASE_READY\n");
} else if (mode === "stream-frame") {
  const replay = new ReplayProvider(
    JSON.parse(readFileSync(approvalId!, "utf8")),
  );
  const provider: ModelProvider = {
    mode: replay.mode,
    model: replay.model,
    async complete(...args) {
      args[4]?.({
        sequence: 1,
        contentDelta: "durable partial text",
        toolDeltas: [
          {
            index: 0,
            id: "partial",
            name: "plan_submit",
            arguments: '{"rationale":',
          },
        ],
      });
      return replay.complete(args[0], args[1], args[2], args[3]);
    },
  };
  store.onEvent = (event) => {
    if (event.type === "model.stream") process.kill(process.pid, "SIGKILL");
  };
  await new Runtime(
    store,
    new Knowledge(loadDataset(resolve(ROOT, "data/synthetic/dataset.json"))),
    provider,
    cfg,
  ).execute(id, user);
  throw new Error("Stream crash boundary was not reached");
} else if (
  [
    "model-before",
    "model-after",
    "proposal-before",
    "proposal-after",
    "tool-cache-before",
    "tool-cache-after",
  ].includes(mode)
) {
  const complete = store.completeModelCall.bind(store);
  store.completeModelCall = (callId, run, body) => {
    if ((body as any).role === "profile" && mode === "model-before")
      process.kill(process.pid, "SIGKILL");
    complete(callId, run, body);
    if ((body as any).role === "profile" && mode === "model-after")
      process.kill(process.pid, "SIGKILL");
  };
  const propose = store.propose.bind(store);
  store.propose = (...args) => {
    if (mode === "proposal-before") process.kill(process.pid, "SIGKILL");
    const result = propose(...args);
    if (mode === "proposal-after") process.kill(process.pid, "SIGKILL");
    return result;
  };
  const putCache = store.putCache.bind(store);
  store.putCache = (...args) => {
    const isProposal = !!(args[2] as any)?.proposalId;
    if (isProposal && mode === "tool-cache-before")
      process.kill(process.pid, "SIGKILL");
    putCache(...args);
    if (isProposal && mode === "tool-cache-after")
      process.kill(process.pid, "SIGKILL");
  };
  await new Runtime(
    store,
    new Knowledge(loadDataset(resolve(ROOT, "data/synthetic/dataset.json"))),
    new ReplayProvider(JSON.parse(readFileSync(approvalId!, "utf8"))),
    cfg,
  ).execute(id, user);
  throw new Error("Model/tool crash boundary was not reached");
} else if (mode === "checkpoint-before" || mode === "checkpoint-after") {
  const put = SqliteSaver.prototype.put;
  SqliteSaver.prototype.put = async function (...args) {
    const ready = store.proposals(id).length > 0;
    const crash = () => {
      const thread = String(args[0].configurable?.thread_id),
        checkpointId = args[1].id;
      const stored = Boolean(
        store.db
          .prepare("select 1 from checkpoints where thread_id=? and id=?")
          .get(thread, checkpointId),
      );
      store.event(id, "test.checkpoint_boundary", {
        mode,
        thread,
        checkpointId,
        stored,
      });
      process.kill(process.pid, "SIGKILL");
    };
    if (ready && mode === "checkpoint-before") crash();
    const result = await put.apply(this, args);
    if (ready && mode === "checkpoint-after") crash();
    return result;
  };
  await new Runtime(
    store,
    new Knowledge(loadDataset(resolve(ROOT, "data/synthetic/dataset.json"))),
    new ReplayProvider(JSON.parse(readFileSync(approvalId!, "utf8"))),
    cfg,
  ).execute(id, user);
  throw Error("Checkpoint crash boundary was not reached");
} else if (mode === "artifact-before" || mode === "artifact-after") {
  const save = store.saveArtifact.bind(store);
  store.saveArtifact = (artifact) => {
    if (mode === "artifact-before") process.kill(process.pid, "SIGKILL");
    save(artifact);
    process.kill(process.pid, "SIGKILL");
  };
  const runtime = new Runtime(
    store,
    new Knowledge(loadDataset(resolve(ROOT, "data/synthetic/dataset.json"))),
    new ReplayProvider(JSON.parse(readFileSync(approvalId!, "utf8"))),
    cfg,
  );
  await runtime.execute(id, user);
  throw new Error("Artifact crash boundary was not reached");
} else if (mode === "coordinate-after") {
  const commit = store.applyCoordination.bind(store);
  store.applyCoordination = (...args) => {
    const result = commit(...args);
    process.kill(process.pid, "SIGKILL");
    return result;
  };
  const runtime = new Runtime(
    store,
    new Knowledge(loadDataset(resolve(ROOT, "data/synthetic/dataset.json"))),
    new ReplayProvider(JSON.parse(readFileSync(approvalId!, "utf8"))),
    cfg,
  );
  await runtime.execute(id, user);
  store.close();
  throw new Error("Coordination crash boundary was not reached");
} else {
  const commit = store.decideApproval.bind(store);
  store.decideApproval = (...args) => {
    if (mode === "before") process.kill(process.pid, "SIGKILL");
    const result = commit(...args);
    if (mode === "after") process.kill(process.pid, "SIGKILL");
    return result;
  };
  const runtime = new Runtime(
    store,
    new Knowledge(loadDataset(resolve(ROOT, "data/synthetic/dataset.json"))),
    new ReplayProvider([]),
    cfg,
  );
  await runtime.execute(id, user, {
    approvalId: approvalId!,
    decision: "approve",
  });
  store.close();
  throw new Error("Crash boundary was not reached");
}
