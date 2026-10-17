import { readFileSync, writeSync } from "node:fs";
import { resolve } from "node:path";
import { Store } from "../../src/storage.js";
import { Runtime } from "../../src/runtime.js";
import { Knowledge } from "../../src/retrieval.js";
import { loadDataset } from "../../src/data.js";
import { ROOT } from "../../src/config.js";
import { ReplayProvider } from "../../src/providers.js";
import { config } from "../test-config.js";
const [path, runId, fixture, mode] = process.argv.slice(2);
if (!path || !runId || !fixture || !["crash", "recover"].includes(mode!))
  throw Error("Invalid fixture");
if (mode === "recover") await new Promise((r) => setTimeout(r, 1300));
const store = new Store(path);
try {
  const replies = JSON.parse(readFileSync(fixture, "utf8")),
    completed = store
      .modelCalls(runId)
      .filter((c) => c.status === "completed").length;
  if (mode === "crash")
    store.onEvent = (event) => {
      if (
        event.type === "model.completed" &&
        store.modelCalls(runId).find((c) => c.id === (event.payload as any).id)
          ?.scope === "plan:4"
      ) {
        writeSync(1, "PLANNING_CLOSE_SAVED");
        process.kill(process.pid, "SIGKILL");
      }
    };
  const runtime = new Runtime(
    store,
    new Knowledge(loadDataset(resolve(ROOT, "data/synthetic/dataset.json"))),
    new ReplayProvider(replies.slice(completed)),
    { ...config(), leaseTtlMs: 1000 },
  );
  const result = await runtime.execute(runId, "u");
  if (result.status !== "partial") throw Error(JSON.stringify(result.error));
} finally {
  store.close();
}
