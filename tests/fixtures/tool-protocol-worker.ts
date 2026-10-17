import { resolve } from "node:path";
import { Store } from "../../src/storage.js";
import { Runtime } from "../../src/runtime.js";
import { Knowledge } from "../../src/retrieval.js";
import { loadDataset } from "../../src/data.js";
import { config, ROOT } from "../../src/config.js";
import { malformedProvider } from "./tool-protocol-provider.js";
const [db, id, user, boundary] = process.argv.slice(2);
if (!db || !id || !user) throw Error("Missing arguments");
const store = new Store(db);
if (boundary === "response") {
  const complete = store.completeModelCall.bind(store);
  store.completeModelCall = (callId, run, body) => {
    complete(callId, run, body);
    if ((body as any).scope === "expert:profile:turn:0")
      process.kill(process.pid, "SIGKILL");
  };
} else {
  const transaction = store.transaction.bind(store);
  store.transaction = <T>(fn: () => T): T => {
    const result = transaction(fn);
    if (store.events(id).some((e) => e.type === "tool.arguments_rejected"))
      process.kill(process.pid, "SIGKILL");
    return result;
  };
}
await new Runtime(
  store,
  new Knowledge(loadDataset(resolve(ROOT, "data/synthetic/dataset.json"))),
  malformedProvider(),
  { ...config(), finalReview: "off", leaseTtlMs: 1500 },
).execute(id, user);
throw Error("Expected process termination not reached");
