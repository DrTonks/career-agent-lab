import type {
  ModelReply,
  ProviderProgress,
  ToolCall,
  Usage,
} from "./contracts.js";
import { z } from "zod";
const count = z.number().int().nonnegative().nullable();
const Frame = z
  .object({
    sequence: z.number().int().positive(),
    contentDelta: z.string().optional(),
    toolDeltas: z
      .array(
        z
          .object({
            index: z.number().int().nonnegative(),
            id: z.string().optional(),
            name: z.string().optional(),
            arguments: z.string().optional(),
          })
          .strict(),
      )
      .optional(),
    usage: z
      .object({ input: count, output: count, cachedInput: count })
      .strict()
      .optional(),
    finishReason: z.string().optional(),
    done: z.boolean().optional(),
  })
  .strict();

/** Semantic fields only: never records hidden reasoning, headers or arbitrary provider metadata. */
export class StreamState {
  private content = "";
  private calls = new Map<number, ToolCall>();
  private usage: Usage = { input: null, output: null, cachedInput: null };
  private finishReason = "";
  sequence = 0;
  done = false;
  apply(frame: ProviderProgress) {
    Frame.parse(frame);
    if (frame.sequence !== this.sequence + 1)
      throw new Error("Non-contiguous provider frame sequence");
    if (this.done) throw new Error("Provider data after stream completion");
    this.sequence = frame.sequence;
    if (frame.contentDelta !== undefined) this.content += frame.contentDelta;
    for (const part of frame.toolDeltas ?? []) {
      if (!Number.isInteger(part.index) || part.index < 0)
        throw new Error("Invalid tool stream index");
      const call = this.calls.get(part.index) ?? {
        id: "",
        type: "function",
        function: { name: "", arguments: "" },
      };
      call.id += part.id ?? "";
      call.function.name += part.name ?? "";
      call.function.arguments += part.arguments ?? "";
      this.calls.set(part.index, call);
    }
    if (frame.usage) this.usage = frame.usage;
    if (frame.finishReason) this.finishReason = frame.finishReason;
    if (frame.done) this.done = true;
  }
  snapshot(): ModelReply {
    const calls = [...this.calls.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, call]) => structuredClone(call));
    return {
      message: {
        role: "assistant",
        content: this.content || null,
        ...(calls.length ? { tool_calls: calls } : {}),
      },
      usage: { ...this.usage },
      finishReason: this.finishReason,
    };
  }
}
