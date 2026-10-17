import { readFileSync, writeSync } from "node:fs";
import { executeComparisonUnit } from "../../src/comparison.js";
import { ReplayProvider } from "../../src/providers.js";
const [out, unit, fixture, mode] = process.argv.slice(2);
if (!out || !unit || !fixture || !["crash", "recover"].includes(mode!))
  throw Error("Invalid worker arguments");
if (mode === "recover") await new Promise((r) => setTimeout(r, 1300));
const provider = new ReplayProvider(JSON.parse(readFileSync(fixture, "utf8")));
if (mode === "crash")
  provider.complete = async () => {
    writeSync(1, "COMPARISON_ROOT_CREATED");
    process.kill(process.pid, "SIGKILL");
    throw Error("unreachable");
  };
const result = await executeComparisonUnit(
  out,
  unit,
  provider,
  mode === "recover",
);
if (result.status !== "completed") throw Error(JSON.stringify(result));
