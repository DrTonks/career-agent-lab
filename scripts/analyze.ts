import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { hash } from "../src/config.js";
const { values: v } = parseArgs({
  options: { records: { type: "string" }, out: { type: "string" } },
});
if (!v.records || !v.out)
  throw new Error("--records FILE --out DIRECTORY required");
const rows = JSON.parse(readFileSync(resolve(v.records), "utf8")) as Record<
  string,
  any
>[];
const pairs = new Map<string, Record<string, any>>();
for (const row of rows) {
  if (
    !["multi-agent", "skills"].includes(row.architecture) ||
    row.mode !== "live"
  )
    throw new Error("Only explicit live A/B records are accepted");
  const id = `${row.caseId}:${row.repeat}`,
    pair = pairs.get(id) ?? {};
  if (pair[row.architecture])
    throw new Error(`Duplicate architecture record: ${id}`);
  pair[row.architecture] = row;
  pairs.set(id, pair);
}
const metrics = [
  "modelCalls",
  "inputTokens",
  "outputTokens",
  "cachedInputTokens",
  "durationMs",
  "peakRssBytes",
  "cpuMicroseconds",
  "toolCalls",
  "toolFailures",
  "communicationBytes",
];
let seed = 20261015;
const random = () => {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return (seed >>> 0) / 4294967296;
};
const mean = (ns: number[]) => ns.reduce((a, b) => a + b, 0) / ns.length;
const comparisons: Record<string, unknown> = {};
for (const metric of metrics) {
  const scenes = new Map<string, number[]>();
  for (const pair of pairs.values()) {
    const a = pair["multi-agent"],
      b = pair.skills;
    if (
      !a ||
      !b ||
      typeof a[metric] !== "number" ||
      typeof b[metric] !== "number"
    )
      continue;
    const values = scenes.get(a.caseId) ?? [];
    values.push(a[metric] - b[metric]);
    scenes.set(a.caseId, values);
  }
  const values = [...scenes.values()].map(mean);
  let interval: number[] | null = null;
  if (values.length >= 5) {
    const samples = Array.from({ length: 2000 }, () =>
      mean(values.map(() => values[Math.floor(random() * values.length)]!)),
    ).sort((a, b) => a - b);
    interval = [samples[49]!, samples[1949]!];
  }
  comparisons[metric] = {
    independentScenarios: values.length,
    meanDifferenceMultiMinusSkills: values.length ? mean(values) : null,
    bootstrap95: interval,
  };
}
const review: unknown[] = [],
  key: unknown[] = [];
for (const [pairId, pair] of pairs) {
  if (!pair["multi-agent"] || !pair.skills) continue;
  const order =
    random() < 0.5 ? ["multi-agent", "skills"] : ["skills", "multi-agent"];
  const id = hash(pairId).slice(0, 12);
  const candidates = order.map((architecture, i) => ({
    label: i === 0 ? "A" : "B",
    text: pair[architecture].answer ?? "",
  }));
  review.push({
    id,
    taskNotes: pair.skills.expectation?.notes,
    candidates,
    ratings: [],
    rubric: [
      "factualSupport",
      "hardConstraints",
      "completeness",
      "actionability",
      "consistency",
    ],
    scale: "1..5, independent reviewer; record supporting evidence",
  });
  key.push({
    id,
    pairId,
    mapping: Object.fromEntries(
      order.map((a, i) => [
        i === 0 ? "A" : "B",
        { architecture: a, runId: pair[a].runId },
      ]),
    ),
  });
}
const out = resolve(v.out);
mkdirSync(out, { recursive: true });
for (const [name, value] of Object.entries({
  "summary.json": {
    runs: rows.length,
    completePairs: review.length,
    qualityConclusion: "unavailable without independent labels",
    comparisons,
    notes: [
      "Differences include failures; inspect status and per-expert artifacts.",
      "Bootstrap samples scenario means, not repeat runs. Fewer than five scenarios: no interval.",
      "Operational measurements do not prove semantic quality or causal architecture superiority.",
    ],
  },
  "blind-review.json": review,
  "blind-key.private.json": key,
}))
  writeFileSync(resolve(out, name), JSON.stringify(value, null, 2));
console.log(
  JSON.stringify({
    output: out,
    runs: rows.length,
    completePairs: review.length,
  }),
);
