import { readFileSync, writeSync } from "node:fs";
import { resolve } from "node:path";
import { Store } from "../../src/storage.js";
import { Runtime } from "../../src/runtime.js";
import { Knowledge } from "../../src/retrieval.js";
import { loadDataset } from "../../src/data.js";
import { ROOT } from "../../src/config.js";
import { ReplayProvider } from "../../src/providers.js";
import { config } from "../test-config.js";

const [path, runId, fixture, boundary, mode] = process.argv.slice(2);
if (
  !path ||
  !runId ||
  !fixture ||
  !["planner-response", "planner-read", "expert-read"].includes(boundary!) ||
  !["crash", "recover"].includes(mode!)
)
  throw Error("Invalid fixture arguments");
if (mode === "recover")
  await new Promise((resolve) => setTimeout(resolve, 1300));
const store = new Store(path);
try {
  const replies = JSON.parse(readFileSync(fixture, "utf8"));
  const completed = store
    .modelCalls(runId)
    .filter((c) => c.status === "completed").length;
  if (mode === "crash")
    store.onEvent = (event) => {
      const hit =
        boundary === "planner-response"
          ? event.type === "model.completed" && event.expert === "orchestrator"
          : event.type === "tool.completed" &&
            (event.payload as any).name === "input_history_read" &&
            event.expert ===
              (boundary === "planner-read" ? "orchestrator" : "profile");
      if (hit) {
        writeSync(1, "HISTORY_BOUNDARY_SAVED");
        process.kill(process.pid, "SIGKILL");
      }
    };
  const runtime = new Runtime(
    store,
    new Knowledge(loadDataset(resolve(ROOT, "data/synthetic/dataset.json"))),
    new ReplayProvider(replies.slice(completed)),
    { ...config(), leaseTtlMs: 1000 },
  );
  const result = await runtime.execute(runId, "recover-history");
  if (result.status !== "partial")
    throw Error(`Unexpected recovered status ${result.status}`);
} finally {
  store.close();
}
