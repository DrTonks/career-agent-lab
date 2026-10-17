import { Config } from "./config.js";
import type {
  Message,
  ModelProvider,
  ModelReply,
  ProviderProgress,
  ToolDefinition,
} from "./contracts.js";
import { StreamState } from "./stream.js";
import { providerRequest } from "./provider-request.js";

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
    readonly usage?: ModelReply["usage"],
    readonly partial?: ModelReply,
  ) {
    super(message);
  }
}
export class CompatibleProvider implements ModelProvider {
  readonly mode = "live" as const;
  readonly model: string;
  constructor(
    private cfg: Config,
    private apiKey: string,
  ) {
    this.model = cfg.model;
    if (!this.model || !apiKey)
      throw new Error("Set CAREER_MODEL and CAREER_API_KEY for live mode");
    const u = new URL(cfg.baseUrl);
    if (
      u.protocol !== "https:" &&
      !["127.0.0.1", "localhost"].includes(u.hostname)
    )
      throw new Error("Remote provider must use HTTPS");
  }
  async complete(
    messages: Message[],
    tools: ToolDefinition[],
    signal: AbortSignal,
    delta?: (text: string) => void,
    progress?: (frame: ProviderProgress) => void,
  ): Promise<ModelReply> {
    const request = providerRequest(this.cfg, messages, tools);
    let response: Response;
    try {
      response = await fetch(request.endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(request.body),
        signal: AbortSignal.any([
          signal,
          AbortSignal.timeout(this.cfg.requestTimeoutMs),
        ]),
      });
    } catch {
      throw new ProviderError(
        signal.aborted
          ? "Provider request cancelled"
          : "Provider request transport failure",
        !signal.aborted,
      );
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new ProviderError(
        `Provider HTTP ${response.status}`,
        [408, 429, 500, 502, 503, 504].includes(response.status),
        response.status,
      );
    }
    if (!response.body)
      throw new ProviderError("Provider has no stream body", true);
    const state = new StreamState();
    let buffer = "";
    const emit = (frame: ProviderProgress) => {
      try {
        state.apply(frame);
      } catch {
        throw new ProviderError(
          "Invalid provider stream fields or sequence",
          false,
        );
      }
      try {
        progress?.(frame);
      } catch {
        throw new ProviderError("Provider stream recorder failed", false);
      }
      if (frame.contentDelta !== undefined) delta?.(frame.contentDelta);
    };
    const consume = (line: string) => {
      if (!line.startsWith("data:")) return;
      const data = line.slice(5).trim();
      if (data === "[DONE]") {
        emit({ sequence: state.sequence + 1, done: true });
        return;
      }
      if (!data) return;
      let item: any;
      try {
        item = JSON.parse(data);
      } catch {
        throw new ProviderError("Malformed provider stream JSON", false);
      }
      if (item.error)
        throw new ProviderError("Provider returned stream error", false);
      const choice = item.choices?.[0];
      const frame: ProviderProgress = { sequence: state.sequence + 1 };
      if (item.usage)
        frame.usage = {
          input: item.usage.prompt_tokens ?? null,
          output: item.usage.completion_tokens ?? null,
          cachedInput:
            item.usage.prompt_tokens_details?.cached_tokens ??
            item.usage.prompt_cache_hit_tokens ??
            null,
        };
      if (choice?.finish_reason) frame.finishReason = choice.finish_reason;
      if (typeof choice?.delta?.content === "string")
        frame.contentDelta = choice.delta.content;
      if (choice?.delta?.tool_calls)
        frame.toolDeltas = choice.delta.tool_calls.map((part: any) => ({
          index: part.index,
          ...(part.id !== undefined ? { id: part.id } : {}),
          ...(part.function?.name !== undefined
            ? { name: part.function.name }
            : {}),
          ...(part.function?.arguments !== undefined
            ? { arguments: part.function.arguments }
            : {}),
        }));
      if (Object.keys(frame).length > 1) emit(frame);
    };
    const reader = response.body.getReader(),
      decoder = new TextDecoder();
    try {
      while (true) {
        signal.throwIfAborted();
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        lines.forEach((l) => consume(l.replace(/\r$/, "")));
      }
      buffer += decoder.decode();
      if (buffer.trim()) consume(buffer.trim());
      const reply = state.snapshot();
      if (!state.done || !reply.finishReason)
        throw new ProviderError("Truncated provider stream", true);
      if (reply.message.tool_calls?.some((c) => !c.id || !c.function.name))
        throw new ProviderError("Malformed tool call", false);
      return reply;
    } catch (error) {
      const partial = state.snapshot();
      throw new ProviderError(
        error instanceof ProviderError
          ? error.message
          : "Provider stream transport or protocol failure",
        error instanceof ProviderError ? error.retryable : !signal.aborted,
        error instanceof ProviderError ? error.status : undefined,
        partial.usage,
        partial,
      );
    } finally {
      try {
        await reader.cancel();
      } catch {
        /* already closed or disconnected */
      }
      reader.releaseLock();
    }
  }
}

/** Explicit fixture playback only. Never used as a fallback for live provider failure. */
export class ReplayProvider implements ModelProvider {
  readonly mode = "replay" as const;
  readonly model = "fixture-replay-not-an-llm";
  private cursor = 0;
  constructor(
    private replies: Array<{
      role?: string;
      toolNames?: string[];
      reply: ModelReply;
    }>,
  ) {}
  async complete(
    messages: Message[],
    tools: ToolDefinition[],
    signal: AbortSignal,
    delta?: (text: string) => void,
  ): Promise<ModelReply> {
    signal.throwIfAborted();
    const item = this.replies[this.cursor++];
    if (!item) throw new Error("Replay exhausted; live fallback is forbidden");
    if (item.role && !messages[0]?.content?.includes(`ROLE: ${item.role}`))
      throw new Error(`Replay role mismatch: expected ${item.role}`);
    if (item.toolNames?.some((n) => !tools.some((t) => t.function.name === n)))
      throw new Error("Replay tool loadout mismatch");
    const reply = structuredClone(item.reply);
    if (reply.message.content) delta?.(reply.message.content);
    return reply;
  }
}
