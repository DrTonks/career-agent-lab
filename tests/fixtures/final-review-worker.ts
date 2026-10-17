import { Store } from "../../src/storage.js";
import { Runtime } from "../../src/runtime.js";
import { Knowledge } from "../../src/retrieval.js";
import { loadDataset } from "../../src/data.js";
import { config, ROOT } from "../../src/config.js";
import { resolve } from "node:path";
import { reviewProvider } from "./final-review-provider.js";
const [db, id, user, boundary] = process.argv.slice(2);
if (!db || !id || !user) throw Error("Missing worker arguments");
const s = new Store(db);
if (boundary === "receipt") {
  const record = s.recordFinal.bind(s);
  s.recordFinal = (id, key, value) => {
    const result = record(id, key, value);
    if (key === "final:receipt") process.kill(process.pid, "SIGKILL");
    return result;
  };
} else {
  const complete = s.completeModelCall.bind(s);
  s.completeModelCall = (callId, run, body) => {
    complete(callId, run, body);
    if ((body as any).scope === "final-review:1")
      process.kill(process.pid, "SIGKILL");
  };
}
await new Runtime(
  s,
  new Knowledge(loadDataset(resolve(ROOT, "data/synthetic/dataset.json"))),
  reviewProvider(),
  { ...config(), finalReview: "model", maxCalls: 6, leaseTtlMs: 1500 },
).execute(id, user);
throw Error("Expected crash boundary not reached");
