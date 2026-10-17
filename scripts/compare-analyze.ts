import { parseArgs } from "node:util";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { analyzeComparison } from "../src/comparison-analysis.js";
import { hash } from "../src/config.js";
import type { ComparisonPlan } from "../src/comparison.js";
const { values: v } = parseArgs({
  options: { plan: { type: "string" }, out: { type: "string" } },
});
if (!v.plan || !v.out) throw Error("--plan DIRECTORY --out NEW_FILE required");
if (existsSync(resolve(v.out)))
  throw Error("Analysis output exists; preserve previous results");
const root = resolve(v.plan),
  read = (p: string) => JSON.parse(readFileSync(resolve(root, p), "utf8"));
const plan = read("plan.json") as ComparisonPlan,
  { hash: expected, ...body } = plan;
if (hash(body) !== expected) throw Error("Plan hash mismatch");
const status = read("status.json");
if (status.planHash !== plan.hash) throw Error("Status plan mismatch");
const rows = [];
for (const pair of new Set(plan.units.map((u) => `${u.caseId}-r${u.repeat}`))) {
  const p = `pairs/${pair}/records.json`;
  if (existsSync(resolve(root, p))) rows.push(...read(p));
}
const known = new Set(
  plan.units.map((u) => JSON.stringify([u.caseId, u.repeat, u.architecture])),
);
if (
  rows.some(
    (r) => !known.has(JSON.stringify([r.caseId, r.repeat, r.architecture])),
  )
)
  throw Error("Unexpected observation identity");
writeFileSync(
  resolve(v.out),
  JSON.stringify(analyzeComparison(plan, status.units, rows), null, 2),
);
console.log(
  JSON.stringify({
    output: resolve(v.out),
    scheduled: plan.units.length,
    observed: rows.length,
  }),
);
