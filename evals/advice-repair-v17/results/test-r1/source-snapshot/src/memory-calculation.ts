import type { Calculation } from "./calculation.js";
import { z } from "zod";

const Scope = z
  .object({
    schema: z.literal("memory-recall-scope-v1"),
    namespaces: z.array(z.string()).length(2),
    snapshot: z.string().regex(/^[a-f0-9]{64}$/u),
    includeInactive: z.boolean(),
    query: z.string(),
    mode: z.enum(["recent", "lexical-bm25"]),
    limit: z.number().int().min(1).max(20),
    cursor: z.string().nullable(),
    nextCursor: z.string().nullable(),
  })
  .strict();
/** Recognize an actual scoped tool calculation; a hash alone proves no semantics. */
export function memoryCalculationScope(body: Calculation) {
  if (
    body.tool !== "memory_recall" ||
    body.result.dataScope !== "authorized-memory"
  )
    return undefined;
  const parsed = Scope.safeParse(body.result.memoryScope);
  if (!parsed.success) return undefined;
  const scope = parsed.data,
    args = body.arguments;
  const counts = body.result.counts as Record<string, unknown> | undefined;
  if (
    !counts ||
    !["totalAvailable", "totalMatches", "returnedCount"].every(
      (k) => Number.isSafeInteger(counts[k]) && Number(counts[k]) >= 0,
    )
  )
    return undefined;
  if (
    scope.namespaces[0] !== "shared" ||
    scope.namespaces[1] !== body.role ||
    scope.query !== args.query ||
    scope.includeInactive !== args.includeInactive ||
    scope.limit !== args.limit ||
    scope.cursor !== (args.cursor ?? null) ||
    scope.mode !== (scope.query.trim() ? "lexical-bm25" : "recent") ||
    Number(counts.totalMatches) > Number(counts.totalAvailable) ||
    Number(counts.returnedCount) >
      Math.min(scope.limit, Number(counts.totalMatches))
  )
    return undefined;
  return scope;
}

/** Clause-local lexical scope only; ambiguous text must not borrow another tool's count. */
export function countSubject(context: string, start: number, end: number) {
  const before = context.slice(0, start),
    after = context.slice(end);
  const left = before.split(/[，,。；;!?！？\n]/u).at(-1)!;
  const right = after.split(/[，,。；;!?！？\n]/u)[0]!;
  const local = left + context.slice(start, end) + right;
  const memory = /记忆|memory|totalAvailable|totalMatches/iu;
  const job =
    /岗位|候选|语料|categoryCoverage|beforeFilter|eligible|matchingCity/iu;
  if (memory.test(local) && job.test(local)) return "ambiguous";
  if (memory.test(local)) return "memory";
  if (job.test(local)) return "jobs";
  const sentence = before.split(/[。；;!?！？\n]/u).at(-1)!;
  const mentions = [...sentence.matchAll(/记忆|memory|岗位|候选|语料/giu)];
  const last = mentions.at(-1)?.[0];
  return last ? (memory.test(last) ? "memory" : "jobs") : "unspecified";
}
export function countToolMatches(
  candidate: { context: string; start: number; end: number },
  tool: string,
  scope?: unknown,
) {
  const subject = countSubject(
    candidate.context,
    candidate.start,
    candidate.end,
  );
  if (
    tool === "memory_recall" &&
    scope &&
    typeof scope === "object" &&
    (scope as { includeInactive?: boolean }).includeInactive
  ) {
    const left = candidate.context
      .slice(0, candidate.start)
      .split(/[，,。；;!?！？\n]/u)
      .at(-1)!;
    const right = candidate.context
      .slice(candidate.end)
      .split(/[，,。；;!?！？\n]/u)[0]!;
    if (/可用|有效|活跃|active/iu.test(left + right)) return false;
  }
  return (
    subject !== "ambiguous" &&
    (tool === "memory_recall" ? subject === "memory" : subject !== "memory")
  );
}
