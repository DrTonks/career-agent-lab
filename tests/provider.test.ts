import test from "node:test";
import assert from "node:assert/strict";
import { CompatibleProvider, ProviderError } from "../src/providers.js";
import { config } from "./test-config.js";
import type { ProviderProgress } from "../src/contracts.js";

test("provider assembles UTF-8 and split tool calls, records actual cache usage", async (t) => {
  const frames = [
    {
      choices: [
        {
          delta: {
            content: "你好",
            reasoning_content: "HIDDEN_REASONING_CANARY",
            tool_calls: [
              {
                index: 0,
                id: "call1",
                function: { name: "read", arguments: '{"id":' },
              },
            ],
          },
        },
      ],
    },
    {
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, function: { arguments: '"1"}' } }],
          },
          finish_reason: "tool_calls",
        },
      ],
    },
    {
      choices: [],
      usage: {
        prompt_tokens: 40,
        completion_tokens: 12,
        prompt_cache_hit_tokens: 16,
      },
    },
  ];
  const bytes = new TextEncoder().encode(
    frames.map((f) => "data: " + JSON.stringify(f) + "\r\n\r\n").join("") +
      "data: [DONE]\n\n",
  );
  t.mock.method(globalThis, "fetch", async (_url: unknown, options: any) => {
    const body = JSON.parse(options.body);
    assert.deepEqual(body.thinking, { type: "disabled" });
    return new Response(
      new ReadableStream({
        start(controller) {
          for (let i = 0; i < bytes.length; i += 7)
            controller.enqueue(bytes.slice(i, i + 7));
          controller.close();
        },
      }),
    );
  });
  const provider = new CompatibleProvider(
    {
      ...config(),
      model: "deepseek-flash",
      baseUrl: "https://api.deepseek.com",
    },
    "test-only",
  );
  const progress: ProviderProgress[] = [];
  const reply = await provider.complete(
    [{ role: "user", content: "测试" }],
    [],
    new AbortController().signal,
    undefined,
    (frame) => progress.push(frame),
  );
  assert.equal(reply.message.content, "你好");
  assert.equal(reply.message.tool_calls?.[0]?.function.arguments, '{"id":"1"}');
  assert.deepEqual(reply.usage, { input: 40, output: 12, cachedInput: 16 });
  assert.equal(progress.at(-1)!.done, true);
  assert.equal(progress[0]!.toolDeltas![0]!.arguments, '{"id":');
  assert(!JSON.stringify(progress).includes("HIDDEN_REASONING_CANARY"));
});

for (const [name, tail] of [
  [
    "EOF after finish reason",
    'data: {"choices":[{"finish_reason":"tool_calls","delta":{}}]}\n',
  ],
  ["malformed JSON", "data: {bad-json}\n"],
  ["DONE without finish", "data: [DONE]\n"],
] as const) {
  test(`provider preserves partial tool payload and usage on ${name}`, async (t) => {
    const first = {
      choices: [
        {
          delta: {
            content: "已收到的正文",
            tool_calls: [
              {
                index: 0,
                id: "t",
                function: { name: "lookup", arguments: '{"query":"未结束' },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 30, completion_tokens: 8 },
    };
    t.mock.method(
      globalThis,
      "fetch",
      async () => new Response(`data: ${JSON.stringify(first)}\n${tail}`),
    );
    const provider = new CompatibleProvider(
      { ...config(), model: "test", baseUrl: "https://api.example.com" },
      "test-only",
    );
    const progress: ProviderProgress[] = [];
    await assert.rejects(
      provider.complete([], [], new AbortController().signal, undefined, (f) =>
        progress.push(f),
      ),
      (error: unknown) => {
        assert(error instanceof ProviderError);
        assert.equal(error.partial?.message.content, "已收到的正文");
        assert.equal(
          error.partial?.message.tool_calls?.[0]?.function.arguments,
          '{"query":"未结束',
        );
        assert.deepEqual(error.usage, {
          input: 30,
          output: 8,
          cachedInput: null,
        });
        return true;
      },
    );
    assert.equal(progress[0]!.sequence, 1);
  });
}

test("provider preserves delivered frames on transport failure and closes the reader", async (t) => {
  let pulls = 0;
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(
        new ReadableStream({
          pull(c) {
            if (pulls++ === 0)
              c.enqueue(
                new TextEncoder().encode(
                  'data: {"choices":[{"delta":{"content":"delivered"}}]}\n',
                ),
              );
            else c.error(new Error("disconnected"));
          },
        }),
      ),
  );
  const provider = new CompatibleProvider(
    { ...config(), model: "test", baseUrl: "https://api.example.com" },
    "test-only",
  );
  await assert.rejects(
    provider.complete([], [], new AbortController().signal),
    (error: unknown) => {
      assert(error instanceof ProviderError);
      assert.equal(error.partial?.message.content, "delivered");
      assert.equal(error.retryable, true);
      return true;
    },
  );
});

test("recorder failure stops the stream rather than silently discarding evidence", async (t) => {
  let cancelled = false;
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(
              new TextEncoder().encode(
                'data: {"choices":[{"delta":{"content":"piece"}}]}\n',
              ),
            );
          },
          cancel() {
            cancelled = true;
          },
        }),
      ),
  );
  const provider = new CompatibleProvider(
    { ...config(), model: "test", baseUrl: "https://api.example.com" },
    "test-only",
  );
  await assert.rejects(
    provider.complete([], [], new AbortController().signal, undefined, () => {
      throw new Error("disk failed");
    }),
    (error: unknown) => {
      assert(error instanceof ProviderError);
      assert.equal(error.retryable, false);
      assert.match(error.message, /recorder/);
      return true;
    },
  );
  assert(cancelled);
});

test("provider rejects incomplete streams instead of treating partial text as success", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n'),
  );
  const provider = new CompatibleProvider(
    { ...config(), model: "test", baseUrl: "https://api.example.com" },
    "test-only",
  );
  await assert.rejects(
    provider.complete([], [], new AbortController().signal),
    /Truncated provider stream/,
  );
});

test("transport failure before response is retryable, explicit cancellation is not", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("connection lost");
  });
  const provider = new CompatibleProvider(
    { ...config(), model: "test", baseUrl: "https://api.example.com" },
    "test-only",
  );
  const controller = new AbortController();
  await assert.rejects(
    provider.complete([], [], controller.signal),
    (error: unknown) => {
      assert(error instanceof ProviderError);
      assert(error.retryable);
      assert.equal(error.partial, undefined);
      return true;
    },
  );
  controller.abort();
  await assert.rejects(
    provider.complete([], [], controller.signal),
    (error: unknown) => {
      assert(error instanceof ProviderError);
      assert(!error.retryable);
      return true;
    },
  );
});
