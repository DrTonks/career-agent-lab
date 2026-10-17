import assert from "node:assert/strict";
import type { ModelProvider, ModelReply } from "../../src/contracts.js";
import { reviewProvider } from "./final-review-provider.js";
import { submissionFixture } from "./review-submission.js";
export const evidenceResume =
  "AAAA ".repeat(1700) + "TAIL_SECRET 已完成一次接口测试。";
export function evidenceProvider(
  mode:
    | "normal"
    | "invalid-first"
    | "repeat"
    | "format"
    | "field"
    | "supplemental" = "normal",
): ModelProvider {
  const base = reviewProvider();
  const call = (name: string, args: unknown): ModelReply => ({
    message: {
      role: "assistant",
      content:
        mode === "supplemental"
          ? "I'll check the relevant evidence and submit the inspection."
          : null,
      tool_calls: [
        {
          id: name,
          type: "function",
          function: { name, arguments: JSON.stringify(args) },
        },
      ],
    },
    usage: { input: 10, output: 10, cachedInput: 0 },
    finishReason: "tool_calls",
  });
  return {
    ...base,
    model: "bounded-evidence-fixture",
    async complete(messages, tools, signal, delta, progress) {
      if (
        tools.some((t) =>
          ["plan_submit", "expert_finish"].includes(t.function.name),
        )
      ) {
        const reply = await base.complete(
          messages,
          tools,
          signal,
          delta,
          progress,
        );
        if (
          mode === "field" &&
          tools.some((t) => t.function.name === "expert_finish")
        ) {
          const finish = reply.message.tool_calls![0]!;
          const args = JSON.parse(finish.function.arguments);
          args.unknowns = ["AAAA ".repeat(2000), "FIELD_SECRET ZZZZ"];
          finish.function.arguments = JSON.stringify(args);
        }
        return reply;
      }
      if (!tools.some((t) => t.function.name === "final_review_submit"))
        return {
          message: { role: "assistant", content: "本次画像需要补充材料。" },
          usage: { input: 10, output: 10, cachedInput: 0 },
          finishReason: "stop",
        };
      const payload = JSON.parse(messages[1]!.content!);
      const history = payload.evidenceRead.history;
      const marker = mode === "field" ? "FIELD_SECRET" : "TAIL_SECRET";
      const badFirst = mode === "invalid-first" && !history.length;
      if (
        !history.length ||
        badFirst ||
        mode === "repeat" ||
        (mode === "invalid-first" && history.length === 1)
      ) {
        if (!history.length)
          assert(
            !payload.sources.some((s: any) =>
              s.fragments.some((f: any) => f.text.includes(marker)),
            ),
          );
        if (history.length === 1 && mode === "invalid-first")
          assert(history[0].error.includes("not authorized"));
        return call("final_evidence_read", {
          requests: [
            mode === "field"
              ? {
                  sourceId: "result:profile",
                  sourceHash: payload.sourceDirectory.find(
                    (s: any) => s.sourceId === "result:profile",
                  ).structured.sourceHash,
                  pointer: "/unknowns/1",
                }
              : {
                  sourceId:
                    badFirst || mode === "repeat"
                      ? "other-run-source"
                      : "resume",
                  offset: evidenceResume.indexOf("TAIL_SECRET"),
                  maxChars: 100,
                },
          ],
        });
      }
      const source = payload.sources.find((s: any) =>
        s.fragments.some((f: any) => f.text.includes(marker)),
      );
      assert(
        source,
        "Explicitly requested page must be in actual next model input",
      );
      if (mode === "format" && messages.length === 2)
        return call("final_review_submit", {});
      return call(
        "final_review_submit",
        submissionFixture(
          {
            factsHash: payload.facts.factsHash,
            extracted: {
              expertCount: null,
              steps: [],
              salaryFilter: null,
              recruitment: null,
            },
            audit: {
              units: payload.units.map((u: any) => ({
                unitIds: [u.id],
                kind: "execution",
                verdict: "supported",
                citations: [{ sourceId: source.id, quote: marker }],
                reason:
                  "Fixture exercises read and binding, not semantic quality",
              })),
              changes: [],
              hardConditionCounts: [],
            },
            issues: [],
          },
          payload,
        ),
      );
    },
  };
}
