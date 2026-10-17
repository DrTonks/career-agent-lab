import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { config, loadEnv, readJson, ROOT } from "../src/config.js";
import {
  prepareComparison,
  verifyComparison,
  executeComparisonUnit,
} from "../src/comparison.js";
import { CompatibleProvider } from "../src/providers.js";
import { archiveExperiment } from "./archive-experiment.js";
const { values: v } = parseArgs({
  options: {
    prepare: { type: "string" },
    out: { type: "string" },
    plan: { type: "string" },
    config: { type: "string" },
    index: { type: "string" },
    unit: { type: "string" },
    live: { type: "boolean" },
    resume: { type: "boolean" },
    "confirm-public-synthetic": { type: "boolean" },
  },
});
if (v.prepare) {
  if (!v.out || v.live || v.unit || v.plan)
    throw Error(
      "Preparation requires --prepare SUITE --out NEW_DIR; never calls a provider",
    );
  loadEnv();
  if (v.config)
    for (const [k, value] of Object.entries(
      readJson<Record<string, string>>(resolve(v.config)),
    )) {
      if (
        !/^CAREER_(?:MAX_|ACTIVE_CONTEXT_TARGET$|REVIEW_SOURCE_TOKENS$|FINAL_RESERVE_)/.test(
          k,
        ) ||
        typeof value !== "string" ||
        !/^\d+$/.test(value)
      )
        throw Error("Only numeric public runtime capacities accepted");
      process.env[k] = value;
    }
  const plan = prepareComparison(
    resolve(v.out),
    readJson(resolve(v.prepare)),
    config(),
    v.index ? resolve(v.index) : undefined,
  );
  console.log(
    JSON.stringify({
      planHash: plan.hash,
      cases: plan.suite.cases.length,
      units: plan.units.length,
      plannedRuns: plan.units.reduce(
        (n, u) =>
          n +
          1 +
          plan.suite.cases.find((c) => c.id === u.caseId)!.replies.length,
        0,
      ),
      liveCalls: 0,
    }),
  );
} else {
  if (!v.plan)
    throw Error(
      "Use --prepare or --plan DIRECTORY [--unit ID --live --confirm-public-synthetic]",
    );
  const out = resolve(v.plan),
    plan = verifyComparison(out);
  if (!v.unit) {
    console.log(
      JSON.stringify({
        planHash: plan.hash,
        status: readJson(resolve(out, "status.json")),
        liveCalls: 0,
      }),
    );
  } else {
    if (!v.live || !v["confirm-public-synthetic"])
      throw Error(
        "Execution requires --live --confirm-public-synthetic; preparation is not authorization",
      );
    loadEnv();
    const provider = new CompatibleProvider(
      plan.config,
      process.env.CAREER_API_KEY ?? "",
    );
    let selected = provider as import("../src/contracts.js").ModelProvider,
      close: (() => void) | undefined;
    const hookPath = resolve(ROOT, ".private/provider-hook.mjs");
    if (existsSync(hookPath)) {
      const wrapped = await (
        await import(pathToFileURL(hookPath).href)
      ).wrap(provider, plan.config);
      selected = wrapped.provider;
      close = wrapped.close;
    }
    try {
      console.log(
        JSON.stringify(
          await executeComparisonUnit(out, v.unit, selected, v.resume),
        ),
      );
    } finally {
      close?.();
      const unit = plan.units.find((u) => u.id === v.unit);
      if (unit) {
        const pair = resolve(out, "pairs", `${unit.caseId}-r${unit.repeat}`);
        if (existsSync(resolve(pair, "runs.sqlite")))
          console.log(
            JSON.stringify({
              archive: await archiveExperiment(
                resolve(pair, "runs.sqlite"),
                pair,
                pair,
              ),
            }),
          );
      }
    }
  }
}
