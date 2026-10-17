import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { Store } from "../src/storage.js";
import { Runtime } from "../src/runtime.js";
import { Knowledge } from "../src/retrieval.js";
import { loadDataset } from "../src/data.js";
import { ReplayProvider } from "../src/providers.js";
import { DomainTools } from "../src/tools.js";
import { Request, Roles, type ModelReply } from "../src/contracts.js";
import { ROOT } from "../src/config.js";
import { config } from "./test-config.js";
import { supportsQuote } from "../src/evidence.js";

const data = loadDataset(resolve(ROOT, "data/synthetic/dataset.json"));
function call(name: string, args: unknown): { reply: ModelReply } {
  return {
    reply: {
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
      usage: { input: 10, output: 10, cachedInput: 0 },
      finishReason: "tool_calls",
    },
  };
}
test("all experts can page only current inputs; unread gaps and other runs remain unavailable", async () => {
  const s = new Store(":memory:"),
    k = new Knowledge(data);
  try {
    const rt = new Runtime(s, k, new ReplayProvider([]), config());
    const r = rt.create(
      Request.parse({
        userId: "input-user",
        conversationId: "c",
        request: "仅本轮西安，不更改长期偏好",
        resumeText:
          "开头" +
          "甲".repeat(400) +
          "中间测试事实" +
          "乙".repeat(400) +
          "末尾",
      }),
    );
    const other = rt.create(
      Request.parse({
        userId: "other",
        conversationId: "c",
        request: "OTHER_USER_SECRET",
      }),
    );
    for (const role of Roles) {
      const tools = new DomainTools(
        role,
        r,
        role,
        s,
        k,
        [],
        new AbortController().signal,
      );
      const first = (await tools.invoke(
        "input_read",
        { source: "resume", maxChars: 200 },
        "first",
      )) as any;
      assert.equal(first.nextOffset, 200);
      assert(supportsQuote(tools.seen.get(first.evidence.id)!, "开头"));
      assert(
        !supportsQuote(tools.seen.get(first.evidence.id)!, "中间测试事实"),
      );
      await tools.invoke(
        "input_read",
        { source: "resume", offset: 600, maxChars: 200 },
        "tail",
      );
      assert(
        !supportsQuote(tools.seen.get(first.evidence.id)!, "中间测试事实"),
      );
      await tools.invoke(
        "input_read",
        { source: "resume", offset: 400, maxChars: 200 },
        "middle",
      );
      assert(supportsQuote(tools.seen.get(first.evidence.id)!, "中间测试事实"));
      const request = (await tools.invoke(
        "input_read",
        { source: "request" },
        "request",
      )) as any;
      assert.equal(request.evidence.kind, "request");
      assert.equal(request.evidence.text, r.request.request);
      await assert.rejects(
        tools.invoke(
          "input_read",
          { source: "request", runId: other.id },
          "foreign",
        ),
      );
      await assert.rejects(
        tools.invoke(
          "knowledge_read",
          { id: `input:${other.id}:request` },
          "foreign-id",
        ),
      );
      assert(
        !JSON.stringify([...tools.seen.values()]).includes("OTHER_USER_SECRET"),
      );
    }
  } finally {
    s.close();
  }
});
for (const architecture of ["multi-agent", "skills"] as const) {
  test(`${architecture}: current request sources durable preference but cannot bypass approval`, async () => {
    const s = new Store(":memory:"),
      replies: Array<{ reply: ModelReply }> = [];
    try {
      const rt = new Runtime(
        s,
        new Knowledge(data),
        new ReplayProvider(replies),
        config(),
      );
      const r = rt.create(
        Request.parse({
          userId: "request-memory",
          conversationId: "c",
          request: "我的长期目标城市是西安，请记住。",
          architecture,
        }),
      );
      const id = `input:${r.id}:request`;
      replies.push(
        call("plan_submit", {
          rationale: "核验偏好",
          steps: [
            {
              id: "match",
              expert: "match",
              objective: "记录用户城市偏好",
              dependsOn: [],
            },
          ],
        }),
        call("input_read", { source: "request" }),
        call("knowledge_read", { id: "rule:match" }),
        call("memory_propose", {
          namespace: "shared",
          key: "city",
          value: "西安",
          evidenceIds: [id],
          expectedVersion: 0,
        }),
        call("expert_finish", {
          status: "needs_input",
          summary: "已提出城市记忆，待审批；岗位条件需补充",
          evidenceIds: [id, "rule:match"],
          unknowns: ["学历和经验"],
          conflicts: [],
          nextActions: [],
          artifact: {},
        }),
        {
          reply: {
            message: { role: "assistant", content: "已记录确认后的偏好" },
            usage: { input: 10, output: 10, cachedInput: 0 },
            finishReason: "stop",
          },
        },
      );
      assert.equal(
        (await rt.execute(r.id, r.request.userId)).status,
        "waiting_approval",
      );
      assert.equal(s.memoryHeads(r.request.userId).length, 0);
      const approvalId = s.approval(r.id)!.approvalId;
      await rt.execute(r.id, r.request.userId, {
        approvalId,
        decision: "approve",
      });
      const memories = s.recallMemories(r.request.userId, "profile", {
        query: "city",
      }).items;
      assert.equal(memories[0]!.value, "西安");
      assert(JSON.stringify(memories[0]!.evidence).includes(id));
      assert.equal(
        s.artifacts(r.id)[0]!.publishedEvidence!.find((e) => e.id === id)!.text,
        r.request.request,
      );
    } finally {
      s.close();
    }
  });
}
