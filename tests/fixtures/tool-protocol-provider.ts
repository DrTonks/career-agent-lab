import type { ModelProvider } from "../../src/contracts.js";
import { reviewProvider } from "./final-review-provider.js";
export function malformedProvider(): ModelProvider {
  const base = reviewProvider();
  return {
    ...base,
    model: "durable-malformed-fixture",
    async complete(messages, tools, ...rest) {
      if (tools.some((t) => t.function.name === "expert_finish")) {
        const count = messages.filter(
          (m) =>
            m.role === "tool" &&
            m.content?.includes('"code":"invalid_tool_json"'),
        ).length;
        return {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: `invalid-${count + 1}`,
                type: "function",
                function: {
                  name: "expert_finish",
                  arguments: '{"status":"needs_input"',
                },
              },
            ],
          },
          usage: { input: 10, output: 10, cachedInput: 0 },
          finishReason: "tool_calls",
        };
      }
      if (!tools.length)
        return {
          message: { role: "assistant", content: "状态说明" },
          usage: { input: 10, output: 10, cachedInput: 0 },
          finishReason: "stop",
        };
      return base.complete(messages, tools, ...rest);
    },
  };
}
