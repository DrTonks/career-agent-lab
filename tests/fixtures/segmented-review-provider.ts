import type { ModelProvider, ModelReply } from "../../src/contracts.js";
import { reviewProvider } from "./final-review-provider.js";
import { submissionFixture } from "./review-submission.js";
export const segmentedDraft = (bad = false) =>
  Array.from({ length: 48 }, (_, i) =>
    i === 18 && bad ? "本次三位专家已完成。" : `简历待补充，记录${i}。`,
  ).join("\n");
export function segmentedProvider(
  mode: "normal" | "repair" | "global-conflict" | "omit" = "normal",
): ModelProvider {
  const base = reviewProvider();
  const call = (name: string, value: unknown): ModelReply => ({
    message: {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: name,
          type: "function",
          function: { name, arguments: JSON.stringify(value) },
        },
      ],
    },
    usage: { input: 10, output: 10, cachedInput: 0 },
    finishReason: "tool_calls",
  });
  return {
    ...base,
    model: "segmented-review-fixture",
    async complete(messages, tools, signal, delta, progress) {
      if (
        tools.some((t) =>
          ["plan_submit", "expert_finish"].includes(t.function.name),
        )
      )
        return base.complete(messages, tools, signal, delta, progress);
      const content = messages.at(-1)!.content!;
      const payload = JSON.parse(content.slice(content.indexOf("{")));
      if (tools.some((t) => t.function.name === "final_consistency_submit"))
        return call("final_consistency_submit", {
          planHash: payload.planHash,
          comparisons:
            mode === "global-conflict"
              ? [
                  {
                    firstUnitId: 0,
                    secondUnitId: 47,
                    relation: "contradiction",
                    scope: "same fixture state",
                    incompatibility: "Fixture cross-part contradiction",
                    reason: "Fixture cross-part contradiction",
                  },
                ]
              : [],
        });
      if (tools.some((t) => t.function.name === "final_review_submit"))
        return call(
          "final_review_submit",
          submissionFixture(
            {
              factsHash: payload.facts.factsHash,
              extracted: {
                expertCount: payload.units.some((u: any) =>
                  u.text.includes("三位"),
                )
                  ? 3
                  : null,
                steps: [],
                salaryFilter: null,
                recruitment: null,
              },
              audit: {
                units: (mode === "omit"
                  ? payload.units.slice(1)
                  : payload.units
                ).map((u: any) => ({
                  unitIds: [u.id],
                  kind: "execution",
                  verdict: "supported",
                  citations: [
                    { sourceId: "facts", quote: '"status":"needs_input"' },
                  ],
                  reason: "",
                })),
                changes: [],
                hardConditionCounts: [],
              },
              issues: [],
            },
            payload,
          ),
        );
      return {
        message: {
          role: "assistant",
          content: segmentedDraft(mode === "repair" && !payload.problems),
        },
        usage: { input: 10, output: 10, cachedInput: 0 },
        finishReason: "stop",
      };
    },
  };
}
