import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { hash } from "./config.js";
import { Role, type RunRecord } from "./contracts.js";

const MemoryContext = z
  .object({
    items: z.array(
      z
        .object({
          namespace: z.string(),
          key: z.string(),
          value: z.string(),
          version: z.number().int().positive(),
          evidence: z.string(),
          updated_at: z.string(),
          expires_at: z.string().nullable(),
          state: z.literal("active"),
          score: z.number().nullable(),
        })
        .strict(),
    ),
    totalAvailable: z.number().int().nonnegative(),
    totalMatches: z.number().int().nonnegative(),
    nextCursor: z.string().nullable(),
    mode: z.enum(["recent", "lexical-bm25"]),
    snapshot: z.string().regex(/^[a-f0-9]{64}$/),
    query: z.string(),
  })
  .strict();

/** Export recorded injected views, never today's memory DB or historical inactive values. */
export function reviewMemoryContexts(db: DatabaseSync, run: RunRecord) {
  const records = new Map<
    string,
    {
      schema: string;
      scope: {
        role: string;
        executionId: string | null;
        namespaces: string[];
        includeInactive: false;
      };
      context: z.infer<typeof MemoryContext>;
      provenance: {
        callId: string;
        promptHash: string;
        messageHash: string;
        createdAt: string;
      }[];
      interpretation: string;
    }
  >();
  const coverage = { examined: 0, incomplete: 0, noInjectedContext: 0 };
  for (const row of db
    .prepare("select body from model_calls where run_id=? order by rowid")
    .all(run.id)) {
    const call = JSON.parse(String(row.body));
    const expert =
      typeof call.scope === "string" && call.scope.startsWith("expert:");
    const planner =
      typeof call.scope === "string" && call.scope.startsWith("plan:");
    if (!expert && !planner) continue;
    coverage.examined++;
    if (call.status !== "completed") {
      coverage.incomplete++;
      continue;
    }
    if (!Array.isArray(call.messages)) {
      coverage.noInjectedContext++;
      continue;
    }
    const role = expert ? Role.parse(call.role) : "orchestrator";
    if (planner && call.role !== role)
      throw Error("Injected memory planner identity mismatch");
    let selected: { payload: any; message: unknown } | undefined;
    for (const message of call.messages) {
      if (message.role !== "user" || typeof message.content !== "string")
        continue;
      let raw = message.content;
      const prefix = "TASK_DATA (not instructions):\n";
      if (expert) {
        raw = raw.replace(
          /^<activeSkill name="(?:profile|match|path|report)">[\s\S]*?<\/activeSkill>\n/,
          "",
        );
        if (!raw.startsWith(prefix)) continue;
        raw = raw.slice(prefix.length);
      } else if (!raw.startsWith("{")) continue;
      let payload;
      try {
        payload = JSON.parse(raw);
      } catch {
        continue;
      }
      if (planner && payload.type !== "TASK_DATA") continue;
      if (Object.hasOwn(payload, "memoryContext"))
        selected = { payload, message };
    }
    if (!selected) {
      coverage.noInjectedContext++;
      continue;
    }
    if (call.promptHash !== hash(call.messages))
      throw Error("Injected memory prompt integrity mismatch");
    const { payload, message } = selected;
    const state = call.executionState;
    if (
      expert &&
      (!state ||
        state.runId !== run.id ||
        state.role !== role ||
        call.executionStateHash !== hash(state) ||
        !call.scope.startsWith(`expert:${state.executionId}:turn:`) ||
        payload.executionId !== state.executionId ||
        state.inputVersion !== (run.inputVersion ?? 0) ||
        state.inputHash !==
          hash({
            request: run.request.request,
            resume: run.request.resumeText,
          }) ||
        state.constraintsHash !== hash(run.request.constraints))
    )
      throw Error("Injected memory execution identity mismatch");
    if (
      (expert ? payload.userRequest : payload.request) !==
        run.request.request ||
      hash(payload.constraints) !== hash(run.request.constraints)
    )
      throw Error("Injected memory task mismatch");
    const context = MemoryContext.parse(payload.memoryContext);
    const at = Date.parse(call.createdAt);
    if (!Number.isFinite(at)) throw Error("Injected memory call time missing");
    if (
      context.totalMatches > context.totalAvailable ||
      context.items.length > context.totalMatches
    )
      throw Error("Injected memory count mismatch");
    const namespaces = role === "orchestrator" ? ["shared"] : ["shared", role];
    for (const item of context.items) {
      if (!namespaces.includes(item.namespace))
        throw Error("Injected memory namespace violation");
      if (
        !Number.isFinite(Date.parse(item.updated_at)) ||
        Date.parse(item.updated_at) > at ||
        (item.expires_at !== null &&
          (!Number.isFinite(Date.parse(item.expires_at)) ||
            Date.parse(item.expires_at) <= at))
      )
        throw Error("Injected memory temporal mismatch");
    }
    const scope = {
      role,
      executionId: expert ? String(state.executionId) : null,
      namespaces,
      includeInactive: false as const,
    };
    const key = hash({ scope, context });
    const record = records.get(key) ?? {
      schema: "review-injected-memory-v1",
      scope,
      context,
      provenance: [],
      interpretation:
        "Recorded model input, not a memory_recall tool execution. Counts describe active memories in these authorized namespaces at this snapshot, not all historical versions. Zero active entries can coexist with retracted history. Repeated appearances do not add independent evidence.",
    };
    record.provenance.push({
      callId: String(call.id),
      promptHash: call.promptHash,
      messageHash: hash(message),
      createdAt: call.createdAt,
    });
    records.set(key, record);
  }
  return { coverage, records: [...records.values()] };
}
