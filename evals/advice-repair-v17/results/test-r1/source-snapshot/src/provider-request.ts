import type { Config } from "./config.js";
import type { Message, ToolDefinition } from "./contracts.js";

const REVIEW_TOOLS = new Set([
  "final_review_submit",
  "final_consistency_submit",
]);
const LOCAL_ONLY = new Set(["minLength", "maxLength", "minItems", "maxItems"]);
/** Only the server schema is projected. The original Zod validator is unchanged. */
export function deepseekStrictSchema(schema: Record<string, unknown>) {
  const omitted: { path: string; keyword: string; value: unknown }[] = [];
  const visit = (input: unknown, path: string): Record<string, unknown> => {
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw Error(`Unsupported strict schema at ${path}`);
    const s = input as Record<string, unknown>,
      out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(s)) {
      if (key === "$schema") continue;
      if (LOCAL_ONLY.has(key)) {
        omitted.push({ path, keyword: key, value });
        continue;
      }
      if (["properties", "$defs", "$def"].includes(key)) {
        out[key] = Object.fromEntries(
          Object.entries(value as Record<string, unknown>).map(
            ([name, child]) => [name, visit(child, `${path}/${key}/${name}`)],
          ),
        );
      } else if (key === "items") out[key] = visit(value, `${path}/items`);
      else if (key === "anyOf")
        out[key] = (value as unknown[]).map((child, i) =>
          visit(child, `${path}/anyOf/${i}`),
        );
      else if (
        [
          "type",
          "description",
          "title",
          "required",
          "additionalProperties",
          "enum",
          "const",
          "default",
          "minimum",
          "maximum",
          "exclusiveMinimum",
          "exclusiveMaximum",
          "multipleOf",
          "pattern",
          "format",
          "$ref",
        ].includes(key)
      )
        out[key] = structuredClone(value);
      else throw Error(`Unsupported strict schema keyword ${key} at ${path}`);
    }
    if (s.type === "object") {
      const names = Object.keys(
        (s.properties ?? {}) as Record<string, unknown>,
      );
      const required = s.required;
      if (
        s.additionalProperties !== false ||
        !Array.isArray(required) ||
        required.length !== names.length ||
        names.some((n) => !required.includes(n))
      )
        throw Error(
          `Strict schema requires every property and disallows extra properties at ${path}`,
        );
    }
    return out;
  };
  return { schema: visit(schema, "#"), omitted };
}

/** Complete non-secret transport plan, shared by execution and request recording. */
export function providerRequest(
  cfg: Config,
  messages: Message[],
  tools: ToolDefinition[],
) {
  const url = new URL(cfg.baseUrl);
  if (url.username || url.password || url.search || url.hash)
    throw Error(
      "Provider base URL cannot contain credentials, query or fragment",
    );
  const requested =
    cfg.reviewTransport === "deepseek-strict" &&
    tools.some((t) => REVIEW_TOOLS.has(t.function.name));
  const omitted: {
    tool: string;
    path: string;
    keyword: string;
    value: unknown;
  }[] = [];
  let endpoint = `${cfg.baseUrl}/chat/completions`,
    wireTools = tools;
  if (requested) {
    if (
      url.protocol !== "https:" ||
      url.hostname !== "api.deepseek.com" ||
      url.port ||
      !["", "/", "/v1", "/beta"].includes(url.pathname) ||
      url.search ||
      url.hash
    )
      throw Error(
        "DeepSeek strict review requires the official HTTPS API origin and a supported base path",
      );
    if (!tools.every((t) => REVIEW_TOOLS.has(t.function.name)))
      throw Error(
        "Strict review request cannot mix domain tools with review tools",
      );
    endpoint = "https://api.deepseek.com/beta/chat/completions";
    wireTools = tools.map((t) => {
      const projected = deepseekStrictSchema(t.function.parameters);
      omitted.push(
        ...projected.omitted.map((item) => ({
          tool: t.function.name,
          ...item,
        })),
      );
      return {
        ...t,
        function: { ...t.function, parameters: projected.schema, strict: true },
      };
    });
  }
  return {
    endpoint,
    schemaPolicy: requested ? "deepseek-strict-v1" : "unchanged",
    omittedServerConstraints: omitted,
    body: {
      model: cfg.model,
      messages,
      ...(wireTools.length ? { tools: wireTools, tool_choice: "auto" } : {}),
      ...(url.hostname === "api.deepseek.com"
        ? { thinking: { type: "disabled" } }
        : {}),
      temperature: 0,
      max_tokens: cfg.maxResponseTokens,
      stream: true,
      stream_options: { include_usage: true },
    },
  };
}
