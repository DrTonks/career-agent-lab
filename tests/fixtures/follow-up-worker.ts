import { Store } from "../../src/storage.js";
import { Runtime } from "../../src/runtime.js";
import { Knowledge } from "../../src/retrieval.js";
import { loadDataset } from "../../src/data.js";
import { ROOT } from "../../src/config.js";
import { ReplayProvider } from "../../src/providers.js";
import { config } from "../test-config.js";
import { resolve } from "node:path";
import { writeSync } from "node:fs";
const [db, parent, user, boundary] = process.argv.slice(2);
if (
  !db ||
  !parent ||
  !user ||
  !["before-commit", "after-commit"].includes(boundary!)
)
  throw Error("Missing crash fixture arguments");
const s = new Store(db),
  rt = new Runtime(
    s,
    new Knowledge(loadDataset(resolve(ROOT, "data/synthetic/dataset.json"))),
    new ReplayProvider([]),
    config(),
  );
const kill = () => {
  writeSync(1, boundary!);
  process.kill(process.pid, "SIGKILL");
};
if (boundary === "before-commit") {
  const create = s.createRun.bind(s);
  s.createRun = (run) => {
    create(run);
    kill();
  };
}
rt.reply(parent, user, {
  operationId: "reply-1",
  reply: "本科应届，用Vue完成表单。暂无企业实习。",
});
if (boundary === "after-commit") kill();
throw Error("Crash boundary not reached");
