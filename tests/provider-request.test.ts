import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import {
  deepseekStrictSchema,
  providerRequest,
} from "../src/provider-request.js";
import { CompatibleProvider } from "../src/providers.js";
import { FinalInspection } from "../src/final-review.js";
import { ReviewSubmission } from "../src/review-submission.js";
import { GlobalInspection } from "../src/review-plan.js";
import { config } from "./test-config.js";
import type { ToolDefinition } from "../src/contracts.js";

const cfg = () => ({
  ...config(),
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-flash",
  reviewTransport: "deepseek-strict" as const,
});
const reviewTool = (): ToolDefinition => ({
  type: "function",
  function: {
    name: "final_review_submit",
    description: "Review",
    parameters: z.toJSONSchema(ReviewSubmission),
  },
});

test("strict projection preserves nullable fields and original local limits", () => {
  const original = z.toJSONSchema(FinalInspection),
    copy = structuredClone(original);
  const projected = deepseekStrictSchema(original);
  assert.deepEqual(original, copy);
  assert(projected.omitted.some((x) => x.keyword === "maxItems"));
  assert(projected.omitted.some((x) => x.keyword === "minLength"));
  assert(!JSON.stringify(projected.schema).includes('"maxItems"'));
  assert(JSON.stringify(projected.schema).includes('"type":"null"'));
  const valid = {
    factsHash: "x",
    audit: { units: [], changes: [], hardConditionCounts: [] },
    extracted: {
      expertCount: null,
      steps: [],
      salaryFilter: null,
      recruitment: null,
    },
    issues: [],
  };
  assert(FinalInspection.safeParse(valid).success);
  assert(
    !FinalInspection.safeParse({
      ...valid,
      issues: [{ excerpt: "", reason: "x" }],
    }).success,
  );
  assert(
    !FinalInspection.safeParse({
      ...valid,
      issues: Array(13).fill({ excerpt: "x", reason: "x" }),
    }).success,
  );
  assert.doesNotThrow(() =>
    deepseekStrictSchema(z.toJSONSchema(GlobalInspection)),
  );
});

test("strict projection rejects optional fields, open objects and unknown keywords", () => {
  for (const schema of [
    z.toJSONSchema(z.object({ a: z.string().optional() }).strict()),
    {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: true,
    },
    { type: "string", imaginaryConstraint: true },
  ])
    assert.throws(() => deepseekStrictSchema(schema));
});

test("strict requests are review-only and constrained to the official origin", () => {
  const tool = reviewTool(),
    request = providerRequest(cfg(), [], [tool]);
  assert.equal(
    request.endpoint,
    "https://api.deepseek.com/beta/chat/completions",
  );
  assert.equal(request.schemaPolicy, "deepseek-strict-v1");
  assert.equal((request.body.tools![0]!.function as any).strict, true);
  const domain = {
    ...tool,
    function: { ...tool.function, name: "knowledge_read" },
  };
  assert.deepEqual(providerRequest(cfg(), [], [domain]).body.tools, [domain]);
  assert.equal(
    providerRequest(cfg(), [], []).endpoint,
    "https://api.deepseek.com/chat/completions",
  );
  assert.throws(() => providerRequest(cfg(), [], [tool, domain]), /mix/);
  for (const baseUrl of [
    "https://other.example",
    "http://api.deepseek.com",
    "https://api.deepseek.com/unknown",
    "https://secret@api.deepseek.com",
    "https://api.deepseek.com?key=secret",
  ])
    assert.throws(() => providerRequest({ ...cfg(), baseUrl }, [], [tool]));
  const ordinary = providerRequest(
    { ...cfg(), reviewTransport: "chat-tools" },
    [],
    [tool],
  );
  assert.deepEqual(ordinary.body.tools, [tool]);
  assert.equal(ordinary.schemaPolicy, "unchanged");
});

test("compatible provider sends exactly the recorded strict plan without recording credentials", async (t) => {
  const tools = [reviewTool()],
    messages = [{ role: "user" as const, content: "Synthetic review" }];
  const plan = providerRequest(cfg(), messages, tools);
  t.mock.method(globalThis, "fetch", async (url: unknown, options: any) => {
    assert.equal(url, plan.endpoint);
    assert.deepEqual(JSON.parse(options.body), plan.body);
    assert.equal(options.headers.Authorization, "Bearer TEST_SECRET_CANARY");
    return new Response(
      'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    );
  });
  await new CompatibleProvider(cfg(), "TEST_SECRET_CANARY").complete(
    messages,
    tools,
    new AbortController().signal,
  );
  assert(!JSON.stringify(plan).includes("TEST_SECRET_CANARY"));
});
