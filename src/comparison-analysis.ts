import type { ComparisonPlan } from "./comparison.js";
/** All scheduled units remain in the denominator. Unknown usage stays null. */
export function analyzeComparison(
  plan: ComparisonPlan,
  units: { id: string; status: string }[],
  rows: Record<string, any>[],
) {
  const metrics = [
    "modelCalls",
    "inputTokens",
    "outputTokens",
    "durationMs",
    "toolCalls",
    "communicationBytes",
  ];
  const observations = plan.units.map((unit) => {
    const selected = rows.filter(
      (r) =>
        r.caseId === unit.caseId &&
        r.repeat === unit.repeat &&
        r.architecture === unit.architecture,
    );
    if (new Set(selected.map((r) => r.turn)).size !== selected.length)
      throw Error("Duplicate turn observations");
    const expected =
      1 + plan.suite.cases.find((c) => c.id === unit.caseId)!.replies.length;
    if (
      selected.some(
        (r) => !Number.isInteger(r.turn) || r.turn < 1 || r.turn > expected,
      )
    )
      throw Error("Unexpected turn");
    const status = units.find((u) => u.id === unit.id)?.status ?? "missing";
    return {
      ...unit,
      stratum: plan.suite.cases.find((c) => c.id === unit.caseId)!.stratum,
      status,
      plannedTurns: expected,
      observedTurns: selected.length,
      missingTurns: expected - selected.length,
      failedTurns: selected.filter((r) =>
        ["failed", "cancelled"].includes(r.status),
      ).length,
      withheldTurns: selected.filter(
        (r) => r.finalReview?.status === "withheld",
      ).length,
      mode: [...new Set(selected.map((r) => r.mode))],
      metrics: Object.fromEntries(
        metrics.map((m) => [
          m,
          selected.length &&
          selected.every(
            (r) => typeof r[m] === "number" && Number.isFinite(r[m]),
          )
            ? selected.reduce((n, r) => n + r[m], 0)
            : null,
        ]),
      ),
      qualityScore: null,
    };
  });
  const deltas = plan.suite.cases.map((c) => {
    const byMetric = Object.fromEntries(
      metrics.map((metric) => {
        const values: number[] = [];
        for (let repeat = 0; repeat < plan.suite.repeats; repeat++) {
          const a = observations.find(
              (o) =>
                o.caseId === c.id &&
                o.repeat === repeat &&
                o.architecture === "multi-agent",
            ),
            b = observations.find(
              (o) =>
                o.caseId === c.id &&
                o.repeat === repeat &&
                o.architecture === "skills",
            );
          // Entire scheduled conversation is needed for end-to-end comparisons.
          if (
            a?.status === "completed" &&
            b?.status === "completed" &&
            !a.missingTurns &&
            !b.missingTurns &&
            typeof a.metrics[metric] === "number" &&
            typeof b.metrics[metric] === "number"
          )
            values.push(a.metrics[metric]! - b.metrics[metric]!);
        }
        return [
          metric,
          {
            pairedRepeats: values.length,
            meanMultiMinusSkills: values.length
              ? values.reduce((a, b) => a + b, 0) / values.length
              : null,
          },
        ];
      }),
    );
    return { caseId: c.id, stratum: c.stratum, metrics: byMetric };
  });
  return {
    schemaVersion: "comparison-analysis-v1",
    planHash: plan.hash,
    scheduledUnits: plan.units.length,
    observedRuns: rows.length,
    units: observations,
    pairedCaseDifferences: deltas,
    qualityStatus: "independent AI assessment pending",
    limitations: [
      "Execution completion and internal review are not business quality labels.",
      "Costs of incomplete/failed units are retained in unit observations; end-to-end paired deltas require complete schedules and known metrics.",
      "Repeats are averaged within cases; this summary does not claim statistical significance or equivalence.",
      "Replay observations are engineering data, never live model quality or latency results.",
    ],
  };
}
