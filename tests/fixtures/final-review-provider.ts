import type { ModelProvider, ModelReply } from "../../src/contracts.js";
import { submissionFixture } from "./review-submission.js";
const response = (content: string): ModelReply => ({
  message: { role: "assistant", content },
  usage: { input: 10, output: 10, cachedInput: 0 },
  finishReason: "stop",
});
const call = (name: string, args: unknown): ModelReply => ({
  ...response(""),
  message: {
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id: name,
        type: "function",
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  },
  finishReason: "tool_calls",
});
export function reviewProvider(
  mode: "repair" | "always-wrong" | "malformed" = "repair",
): ModelProvider {
  return {
    mode: "replay",
    model: "final-review-fixture",
    async complete(messages, tools) {
      if (tools.some((t) => t.function.name === "plan_submit"))
        return call("plan_submit", {
          rationale: "仅画像",
          steps: [
            {
              id: "profile",
              expert: "profile",
              objective: "画像",
              dependsOn: [],
            },
          ],
        });
      if (tools.some((t) => t.function.name === "expert_finish"))
        return call("expert_finish", {
          status: "needs_input",
          summary: "需要简历",
          evidenceIds: [],
          unknowns: ["缺少简历"],
          conflicts: [],
          nextActions: [],
          artifact: {},
        });
      const text = messages.at(-1)!.content!;
      const payload = JSON.parse(text.slice(text.indexOf("{")));
      if (tools.some((t) => t.function.name === "final_review_submit")) {
        if (
          payload.facts.executionHistory?.available !== true ||
          !payload.facts.executionHistory.attempts.length
        )
          throw Error("Review is missing authoritative execution history");
        if (
          !payload.sources?.some(
            (s: any) =>
              s.id === "rule:profile" &&
              s.fragments.some((f: any) => f.text.includes("learning")),
          )
        )
          throw Error("Review is missing scoring standards");
        if (
          !payload.facts.constraintSemantics.applicantFacts.includes(
            "experienceYears",
          )
        )
          throw Error("Review is missing applicant fact boundaries");
        return call(
          "final_review_submit",
          submissionFixture(
            mode === "malformed"
              ? {}
              : {
                  factsHash: payload.facts.factsHash,
                  audit: {
                    units: payload.units.map((unit: any) => ({
                      unitIds: [unit.id],
                      kind: "execution",
                      verdict: "supported",
                      citations: [
                        {
                          sourceId: "facts",
                          quote: '"expertCount":' + payload.facts.expertCount,
                        },
                      ],
                      reason:
                        "Fixture: extracted fields below exercise status/count enforcement",
                    })),
                    changes: [],
                    hardConditionCounts: [],
                  },
                  extracted: {
                    expertCount:
                      mode === "always-wrong" ||
                      !payload.units[0]?.text.startsWith("修订")
                        ? 3
                        : 1,
                    steps: [],
                    salaryFilter: null,
                    recruitment: null,
                  },
                  issues: [],
                },
            payload,
          ),
        );
      }
      return response(
        payload.problems
          ? "修订：仅一位画像专家，需要补充简历。"
          : "本次三位专家已完成分析。",
      );
    },
  };
}
