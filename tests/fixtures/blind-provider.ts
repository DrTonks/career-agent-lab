import { hash } from "../../src/config.js";
import { dimensions, type BlindBundle } from "../../src/blind-review.js";
import type { ModelProvider } from "../../src/contracts.js";
export const blindBundle: BlindBundle = {
  version: "blind-review-v1",
  dataClass: "public-synthetic",
  split: "development",
  seed: 11,
  cases: [
    {
      id: "case",
      track: "delivered",
      sources: [
        {
          id: "task",
          kind: "request",
          text: "请给出建议",
          sha256: hash("请给出建议"),
        },
      ],
      candidates: [
        { label: "A", text: "建议先补充资料。" },
        { label: "B", text: "建议保留未知。" },
      ],
    },
  ],
};
export function blindProvider(
  onCall?: () => void,
  boundary?: string,
): ModelProvider {
  return {
    mode: "replay",
    model: "blind-fixture",
    async complete(messages, _tools, _signal, _delta, progress) {
      onCall?.();
      const task = JSON.parse(messages[1]!.content!);
      const basis = (c: { fragments: { id: string }[] }) => ({
        answerEvidenceIds: c.fragments.map((f) => f.id),
        evidenceIds: [task.sources[0].fragments[0].id],
        reason: "Fixture contract verification only",
      });
      const result =
        task.candidates.length === 1
          ? {
              label: task.candidates[0].label,
              dimensions: dimensions.map((d) => ({
                dimension: d,
                score: 3,
                ...basis(task.candidates[0]),
              })),
              findings: [],
              blindGuess: "",
              limitations: [],
            }
          : {
              preference: "tie",
              reasons: task.candidates.map((c: any) => ({
                label: c.label,
                ...basis(c),
              })),
              limitations: [],
            };
      const call = {
        id: "judge-call",
        type: "function" as const,
        function: { name: "judge_submit", arguments: JSON.stringify(result) },
      };
      progress?.({
        sequence: 1,
        toolDeltas: [
          {
            index: 0,
            id: call.id,
            name: call.function.name,
            arguments: call.function.arguments,
          },
        ],
      });
      if (boundary === "partial") process.kill(process.pid, "SIGKILL");
      const usage = { input: 20, output: 50, cachedInput: 0 };
      progress?.({ sequence: 2, finishReason: "tool_calls", usage });
      progress?.({ sequence: 3, done: true });
      if (boundary === "stream") process.kill(process.pid, "SIGKILL");
      return {
        message: { role: "assistant", content: null, tool_calls: [call] },
        finishReason: "tool_calls",
        usage,
      };
    },
  };
}
