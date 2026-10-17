import { Store } from "../../src/storage.js";
import { DomainTools } from "../../src/tools.js";
import { Knowledge } from "../../src/retrieval.js";
import { loadDataset } from "../../src/data.js";
import { ROOT } from "../../src/config.js";
import { resolve } from "node:path";
import { readFileSync, writeSync } from "node:fs";
const [db, id, boundary, args] = process.argv.slice(2);
if (
  !db ||
  !id ||
  !args ||
  !["before-commit", "after-commit", "recover"].includes(boundary!)
)
  throw Error("Missing crash fixture arguments");
const s = new Store(db),
  t = new DomainTools(
    "profile",
    s.run(id),
    "profile",
    s,
    new Knowledge(loadDataset(resolve(ROOT, "data/synthetic/dataset.json"))),
    [],
    new AbortController().signal,
  );
await t.invoke("input_read", { source: "request" }, "request");
await t.invoke("resume_read", {}, "resume");
const kill = () => {
  writeSync(1, boundary!);
  process.kill(process.pid, "SIGKILL");
};
if (boundary === "before-commit") {
  const original = s.putCache.bind(s);
  s.putCache = (run, key, result) => {
    original(run, key, result);
    if (key.startsWith("clarification:profile:profile:command:")) kill();
  };
}
await t.invoke(
  "clarification_update",
  JSON.parse(readFileSync(args, "utf8")),
  "update",
);
if (boundary === "after-commit") kill();
if (boundary !== "recover") throw Error("Crash boundary not reached");
s.close();
