import { Store } from "../../src/storage.js";
import { Runtime } from "../../src/runtime.js";
import { config, ROOT } from "../../src/config.js";
import { Knowledge } from "../../src/retrieval.js";
import { loadDataset } from "../../src/data.js";
import { resolve } from "node:path";
import { evidenceProvider } from "./review-evidence-provider.js";
const [db, id, user, boundary, readMode = "normal"] = process.argv.slice(2);
if (!db || !id || !user) throw Error("Missing arguments");
const store = new Store(db);
if (boundary === "read-receipt") {
  const record = store.recordFinal.bind(store);
  store.recordFinal = (id, key, value) => {
    const result = record(id, key, value);
    if (key === "final:part:0:0:evidence:0")
      process.kill(process.pid, "SIGKILL");
    return result;
  };
} else {
  const record = store.completeModelCall.bind(store);
  store.completeModelCall = (callId, run, body) => {
    record(callId, run, body);
    if ((body as { scope?: string }).scope === "final-review:0")
      process.kill(process.pid, "SIGKILL");
  };
}
await new Runtime(
  store,
  new Knowledge(loadDataset(resolve(ROOT, "data/synthetic/dataset.json"))),
  evidenceProvider(
    readMode === "field"
      ? "field"
      : readMode === "supplemental"
        ? "supplemental"
        : "normal",
  ),
  { ...config(), finalReview: "model", maxCalls: 5, leaseTtlMs: 1500 },
).execute(id, user);
throw Error("Expected crash not reached");
