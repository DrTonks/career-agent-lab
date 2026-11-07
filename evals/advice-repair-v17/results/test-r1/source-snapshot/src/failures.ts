import { ProviderError } from "./providers.js";
import type { Artifact } from "./contracts.js";

export class RuntimeLimitError extends Error {
  constructor(
    readonly code: "expert_turn_limit" | "context_limit" | "run_limit",
    message: string,
  ) {
    super(message);
  }
}
export class ModelProtocolError extends Error {}
export class ExpertProgressError extends Error {}
export function classifyFailure(
  error: unknown,
): NonNullable<Artifact["failure"]> {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof ExpertProgressError)
    return { code: "expert_no_progress", retryable: false, message };
  if (error instanceof ModelProtocolError)
    return { code: "model_protocol", retryable: false, message };
  if (error instanceof ProviderError)
    return {
      code: error.retryable ? "provider_transient" : "provider_permanent",
      retryable: error.retryable,
      message,
    };
  if (error instanceof RuntimeLimitError)
    return {
      code: error.code,
      retryable: error.code === "expert_turn_limit",
      message,
    };
  return { code: "internal_error", retryable: false, message };
}
