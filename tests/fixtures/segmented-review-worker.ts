import { Store } from "../../src/storage.js";
import { Runtime } from "../../src/runtime.js";
import { Knowledge } from "../../src/retrieval.js";
import { loadDataset } from "../../src/data.js";
import { config, ROOT } from "../../src/config.js";
import { resolve } from "node:path";
import { segmentedProvider } from "./segmented-review-provider.js";
const [db, id, user, boundary] = process.argv.slice(2);
if (!db || !id || !user) throw Error("Missing arguments");
const s = new Store(db);
if (boundary === "receipt") {
  const record = s.recordFinal.bind(s);
  s.recordFinal = (id, key, value) => {
    const result = record(id, key, value);
    if (key === "final:part:0:1") process.kill(process.pid, "SIGKILL");
    return result;
  };
} else {
  const complete = s.completeModelCall.bind(s);
  s.completeModelCall = (callId, run, body) => {
    complete(callId, run, body);
    if ((body as { scope?: string }).scope === "final-review:0:part:1")
      process.kill(process.pid, "SIGKILL");
  };
}
await new Runtime(
  s,
  new Knowledge(loadDataset(resolve(ROOT, "data/synthetic/dataset.json"))),
  segmentedProvider(),
  { ...config(), finalReview: "model", maxCalls: 7, leaseTtlMs: 1500 },
).execute(id, user);
throw Error("Expected crash not reached");
