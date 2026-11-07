import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { z } from "zod";
import { hash, readJson } from "./config.js";
import { loadDataset } from "./data.js";
import {
  Architecture,
  Evidence,
  FollowUp,
  Request,
  type Artifact,
  type RunRecord,
} from "./contracts.js";
import { parseCalculation } from "./calculation.js";
import { followUpInput } from "./follow-up.js";
import { blindCommonSources } from "./blind-materials.js";
import { validateBundle, type BlindBundle } from "./blind-review.js";
import { reviewToolObservations } from "./review-tool-observations.js";
import { memoryReviewTimeline } from "./memory-review.js";
import { reviewMemoryContexts } from "./review-memory-context.js";

const Scenario = z.object({
  memoryPolicy: z.literal("recorded-approvals-v1").optional(),
  first: z.union([
    Request.omit({
      userId: true,
      conversationId: true,
      architecture: true,
    }),
    // Unified plans store the complete template. Execution identities are
    // independently checked against each recorded chain below, never exposed
    // as task evidence or taken from the template to authorize a chain.
    Request.transform((r) => ({
      request: r.request,
      resumeText: r.resumeText,
      constraints: r.constraints,
      approvalRequired: r.approvalRequired,
    })),
  ]),
  replies: z.array(FollowUp).min(1),
  architectures: z.array(Architecture).length(2),
  turns: z.number().int().min(2),
});
const Rows = z.array(
  z.object({
    caseId: z.string(),
    repeat: z.number().int().nonnegative(),
    turn: z.number().int().positive(),
    runId: z.string(),
    architecture: Architecture,
    mode: z.literal("live"),
    answer: z.string(),
    status: z.string(),
  }),
);
type Source = Omit<BlindBundle["cases"][number]["sources"][number], "sha256">;
const same = (a: unknown, b: unknown, message: string) => {
  if (hash(a) !== hash(b)) throw Error(message);
};
const userInput = (request: RunRecord["request"]) => ({
  request: request.request,
  resumeText: request.resumeText,
  constraints: request.constraints,
  approvalRequired: request.approvalRequired,
});

/** Export a complete paired scripted conversation. No model calls, summaries or quality labels.
 * Confirmed-memory histories and incomplete schedules require separate evidence and are rejected.
 */
export function prepareConversationMaterials(
  experimentDir: string,
  seed: number,
  track: "delivered" | "draft" = "delivered",
) {
  const root = resolve(experimentDir);
  const data = loadDataset(resolve(root, "snapshot/dataset.json"));
  if (data.source !== "synthetic")
    throw Error("Only public synthetic experiments supported");
  const rawScenario = readJson(resolve(root, "scenario.json"));
  const scenario = Scenario.parse(rawScenario);
  if (
    new Set(scenario.architectures).size !== 2 ||
    scenario.replies.length !== scenario.turns - 1
  )
    throw Error("Invalid paired conversation schedule");
  const rawRecords = readJson(resolve(root, "records.json"));
  const rows = Rows.parse(rawRecords);
  const pairKeys = new Set(
    rows.map((r) => JSON.stringify([r.caseId, r.repeat])),
  );
  if (
    pairKeys.size !== 1 ||
    rows.length !== scenario.turns * 2 ||
    new Set(rows.map((r) => r.runId)).size !== rows.length
  )
    throw Error(
      "Require one complete paired conversation; missing and duplicate runs cannot be silently excluded",
    );
  const pairId = [...pairKeys][0]!;
  const order = [...scenario.architectures].sort();
  if (parseInt(hash([seed, pairId]).slice(0, 8), 16) % 2) order.reverse();
  const labels = new Map(
    order.map((arch, index) => [
      arch,
      index === 0 ? ("A" as const) : ("B" as const),
    ]),
  );
  const common = blindCommonSources(root, data);
  const cases: BlindBundle["cases"] = [];
  const mapping: unknown[] = [],
    missing: unknown[] = [];
  const db = new DatabaseSync(resolve(root, "runs.sqlite"), { readOnly: true });
  db.exec("BEGIN");
  try {
    const storedRows = db.prepare("select body from runs").all();
    if (storedRows.length !== rows.length)
      throw Error("Database contains unrepresented runs");
    const runs = new Map(
      storedRows.map((r) => {
        const run = JSON.parse(String(r.body)) as RunRecord;
        return [run.id, run];
      }),
    );
    const chains = new Map<string, RunRecord[]>();
    for (const architecture of order) {
      const chain: RunRecord[] = [];
      for (let turn = 1; turn <= scenario.turns; turn++) {
        const matches = rows.filter(
          (r) => r.architecture === architecture && r.turn === turn,
        );
        if (matches.length !== 1)
          throw Error("Missing or duplicate conversation turn");
        const row = matches[0]!,
          run = runs.get(row.runId);
        if (
          !run ||
          run.mode !== "live" ||
          run.datasetVersion !== data.version ||
          run.request.architecture !== architecture ||
          (run.answer ?? "") !== row.answer ||
          run.status !== row.status
        )
          throw Error("Record/database provenance mismatch");
        if (["created", "running", "waiting_approval"].includes(run.status))
          throw Error("Cannot assess active run");
        if (!scenario.memoryPolicy && run.memorySnapshot !== hash([]))
          throw Error(
            "Confirmed-memory timelines require a dedicated memory exporter",
          );
        const file = readJson<{ request: unknown; continuation: unknown }>(
          resolve(root, `${run.id}.request.json`),
        );
        same(file.request, run.request, "Request file/database mismatch");
        same(
          file.continuation,
          run.continuation ?? null,
          "Continuation file/database mismatch",
        );
        const parent = chain.at(-1);
        if (!parent) {
          if (run.continuation || run.inputVersion !== 0)
            throw Error("First turn cannot have a parent");
          same(
            userInput(run.request),
            scenario.first,
            "Initial task/scenario mismatch",
          );
        } else {
          if (
            parent.request.userId !== run.request.userId ||
            parent.request.conversationId !== run.request.conversationId ||
            parent.inputVersion === undefined ||
            run.inputVersion !== parent.inputVersion + 1
          )
            throw Error("Conversation identity or input version mismatch");
          const reply = scenario.replies[turn - 2]!;
          const artifacts = db
            .prepare(
              "select body from artifacts where run_id=? order by step_id",
            )
            .all(parent.id)
            .map((r) => JSON.parse(String(r.body)) as Artifact);
          const expected = followUpInput(
            parent,
            reply,
            artifacts,
            run.continuation?.version,
            run.continuation?.questionPolicy ?? "legacy",
          );
          same(
            expected.request,
            run.request,
            "User reply reconstruction mismatch",
          );
          const continuation = run.continuation;
          if (!continuation) throw Error("Missing continuation");
          const { snapshotHash, ...body } = continuation;
          same(hash(body), snapshotHash, "Continuation snapshot mismatch");
          // Question ordering is recorded by the original runtime; compare contents without inventing a new order.
          const { questions: actualQuestions, ...actualRest } = body;
          const {
            questions: expectedQuestions,
            snapshotHash: _,
            ...expectedRest
          } = expected.continuation;
          same(actualRest, expectedRest, "Continuation identity mismatch");
          same(
            actualQuestions.map((q) => hash(q)).sort(),
            expectedQuestions.map((q) => hash(q)).sort(),
            "Continuation question provenance mismatch",
          );
          const command = db
            .prepare("select * from follow_up_commands where child_id=?")
            .all(run.id);
          if (
            command.length !== 1 ||
            command[0]!.parent_id !== parent.id ||
            command[0]!.user_id !== run.request.userId ||
            command[0]!.operation_id !== reply.operationId ||
            command[0]!.request_hash !== hash(reply)
          )
            throw Error("Missing or inconsistent follow-up command");
        }
        chain.push(run);
      }
      chains.set(architecture, chain);
      const userId = chain[0]!.request.userId;
      if (
        !scenario.memoryPolicy &&
        (Number(
          db
            .prepare("select count(*) n from memories where user_id=?")
            .get(userId)?.n,
        ) ||
          Number(
            db
              .prepare("select count(*) n from memory_history where user_id=?")
              .get(userId)?.n,
          ))
      )
        throw Error(
          "Confirmed-memory timelines require a dedicated memory exporter",
        );
    }
    if (
      chains.get(order[0]!)![0]!.request.userId ===
      chains.get(order[1]!)![0]!.request.userId
    )
      throw Error("Paired architectures must use separate user identities");
    for (let index = 0; index < scenario.turns; index++) {
      const first = chains.get(order[0]!)![index]!,
        second = chains.get(order[1]!)![index]!;
      same(
        userInput(first.request),
        userInput(second.request),
        "Paired current task mismatch",
      );
      const id = hash([
        seed,
        pairId,
        index + 1,
        track,
        "conversation-v1",
      ]).slice(0, 24);
      const sources: Source[] = [
        { id: "task", kind: "request", text: first.request.request },
        {
          id: "resume",
          kind: "resume",
          text: first.request.resumeText || "（未提供简历）",
        },
        {
          id: "constraints",
          kind: "request",
          text: JSON.stringify(first.request.constraints),
        },
        {
          id: "timeline-policy",
          kind: "review-context",
          text: JSON.stringify({
            turn: index + 1,
            totalTurns: scenario.turns,
            rule: "用户更正按时间和明确替换关系解释，历史说法不能覆盖当前输入。历史助手答复只供检查一致性与重复追问，不是个人事实来源。candidate标记的材料仅属于相应候选；执行状态和内部审核不证明质量。评当前轮交付，不用后续尚未发生的回复替它补足。",
          }),
        },
        {
          id: "user-turn:1",
          kind: "request",
          text: JSON.stringify({ turn: 1, ...scenario.first }),
        },
        ...scenario.replies.slice(0, index).map((r, i) => ({
          id: `user-turn:${i + 2}`,
          kind: "request",
          text: JSON.stringify({
            turn: i + 2,
            reply: r.reply,
            resumeReplaced: r.resumeText !== undefined,
            ...(r.resumeText !== undefined ? { resumeText: r.resumeText } : {}),
            constraintsReplaced: r.constraints !== undefined,
            ...(r.constraints !== undefined
              ? { constraints: r.constraints }
              : {}),
          }),
        })),
        ...common,
      ];
      const candidates = order.map((architecture) => {
        const label = labels.get(architecture)!,
          chain = chains.get(architecture)!,
          run = chain[index]!;
        if (scenario.memoryPolicy)
          sources.push({
            id: `memory-history:${label}`,
            kind: "memory-control",
            candidate: label,
            text: JSON.stringify(memoryReviewTimeline(db, chain, index)),
          });
        for (let old = 0; old < index; old++)
          sources.push({
            id: `history:${label}:${old + 1}`,
            kind: "assistant-history",
            candidate: label,
            text: JSON.stringify({
              turn: old + 1,
              deliveredAnswer: chain[old]!.answer ?? "",
              status: chain[old]!.status,
            }),
          });
        const artifacts = db
          .prepare("select body from artifacts where run_id=? order by step_id")
          .all(run.id)
          .map((r) => JSON.parse(String(r.body)) as Artifact);
        const attempts = db
          .prepare(
            "select body from artifact_history where run_id=? order by rowid",
          )
          .all(run.id)
          .map((r) => JSON.parse(String(r.body)) as Artifact);
        sources.push({
          id: `execution:${label}`,
          kind: "control",
          candidate: label,
          text: JSON.stringify({
            candidate: label,
            turn: index + 1,
            status: run.status,
            current: artifacts.map((a) => ({
              expert: a.expert,
              stepId: a.stepId,
              status: a.result.status,
              attempt: a.attempt ?? 1,
            })),
            attempts: attempts.map((a) => ({
              expert: a.expert,
              stepId: a.stepId,
              status: a.result.status,
              attempt: a.attempt ?? 1,
            })),
          }),
        });
        // Exact source receipts support execution/count claims, not the semantics of expert conclusions.
        const injectedMemory = reviewMemoryContexts(db, run);
        sources.push({
          id: `memory-context-coverage:${label}`,
          kind: "control",
          candidate: label,
          text: JSON.stringify(injectedMemory.coverage),
        });
        for (const [i, record] of injectedMemory.records.entries())
          sources.push({
            id: `memory-context:${label}:${i + 1}`,
            kind: "memory-context",
            candidate: label,
            text: JSON.stringify(record),
          });
        const toolRecords = reviewToolObservations(db, run, artifacts);
        sources.push({
          id: `tool-coverage:${label}`,
          kind: "control",
          candidate: label,
          text: JSON.stringify({
            schema: "review-tool-coverage-v1",
            coverage: toolRecords.coverage,
            rule: "工具记录证明实际执行的参数与结果，不证明模型选定的观察、能力等级或用户技能正确。须核对当前原始用户材料。incomplete只表示缺完成事件，不断言没有副作用；重放不增加独立证据权重。覆盖范围仅profile_score和jobs_check。",
          }),
        });
        for (const [i, record] of toolRecords.observations.entries())
          sources.push({
            id: `tool-observation:${label}:${i + 1}`,
            kind: "tool-observation",
            candidate: label,
            text: JSON.stringify(record),
          });
        const receipts = db
          .prepare(
            "select key,result from tool_cache where run_id=? and key like 'calculation-source:%' order by key",
          )
          .all(run.id);
        for (const [receiptIndex, row] of receipts.entries()) {
          const evidence = Evidence.parse(JSON.parse(String(row.result))),
            body = parseCalculation(evidence);
          if (
            body.runId !== run.id ||
            body.datasetVersion !== data.version ||
            row.key !== `calculation-source:${evidence.id}`
          )
            throw Error("Calculation receipt provenance mismatch");
          sources.push({
            id: `calculation:${label}:${receiptIndex + 1}`,
            kind: "calculation",
            candidate: label,
            text: evidence.text,
          });
        }
        let text = run.answer ?? "";
        if (track === "draft") {
          const drafts = db
            .prepare(
              "select key,result from tool_cache where run_id=? and key like 'final:draft:%'",
            )
            .all(run.id)
            .sort(
              (a, b) =>
                Number(String(a.key).split(":").at(-1)) -
                Number(String(b.key).split(":").at(-1)),
            );
          const last = drafts.at(-1);
          if (last) {
            const value: unknown = JSON.parse(String(last.result));
            if (typeof value !== "string") throw Error("Invalid draft receipt");
            text = value;
          } else {
            missing.push({ caseId: id, label, reason: "no-draft" });
            text = "";
          }
        }
        mapping.push({
          caseId: id,
          pairId,
          turn: index + 1,
          track,
          label,
          runId: run.id,
          architecture,
          originalAnswerHash: hash(text),
          status: run.status,
          finalReview: run.finalReview ?? null,
        });
        return { label, text };
      });
      cases.push({
        id,
        track,
        candidates,
        sources: sources.map((s) => ({ ...s, sha256: hash(s.text) })),
      });
    }
    const bundle = validateBundle({
      version: "blind-review-v2-candidate-sources",
      dataClass: "public-synthetic",
      split: "development",
      seed,
      cases,
    });
    return {
      bundle,
      mapping,
      provenance: {
        exporter: "scripted-conversation-v3-injected-memory",
        bundleHash: hash(bundle),
        recordsHash: hash(rawRecords),
        scenarioHash: hash(rawScenario),
        datasetHash: hash(data),
        missing,
        limitations: [
          "Development material export, not independent ratings or business acceptance",
          "Requires complete paired terminal schedules. Confirmed memory needs explicit recorded-approvals-v1 and verified in-chain approval/version history; external commands and incomplete schedules are rejected, not filtered",
          "Historical delivered answers are candidate-specific assistant claims, never personal evidence",
          "No future input, architecture mapping, internal review result or prior rating is sent to the judge; raw answer/receipt text may still reveal identity",
          "Full text is preserved; oversized judge payloads need a separately validated segmentation strategy",
        ],
      },
    };
  } finally {
    db.exec("ROLLBACK");
    db.close();
  }
}
