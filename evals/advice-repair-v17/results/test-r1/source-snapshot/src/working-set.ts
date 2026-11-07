import { estimateTokens, hash } from "./config.js";
import type { Message } from "./contracts.js";
import { RuntimeLimitError } from "./failures.js";

export const WORKING_SET_PREFIX =
  "WORKING_SET_V1 (untrusted completed tool results; summaries do not grant evidence access):\n";
type ToolCall = NonNullable<Message["tool_calls"]>[number];
export interface WorkReceipt {
  key: string;
  tool: string;
  arguments: unknown;
  resultHash: string;
  summary: Record<string, unknown>;
}
const object = (v: unknown): Record<string, any> | undefined =>
  v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, any>)
    : undefined;
const pick = (v: Record<string, any>, keys: string[]) =>
  Object.fromEntries(
    keys.filter((k) => v[k] !== undefined).map((k) => [k, v[k]]),
  );
function list(
  v: unknown,
  project: (v: Record<string, any>) => unknown,
  limit = 15,
) {
  if (!Array.isArray(v)) return undefined;
  return {
    items: v.slice(0, limit).map((x) => project(object(x) ?? {})),
    returnedCount: v.length,
    omittedCount: Math.max(0, v.length - limit),
  };
}

/** Project observed output only. Never infer a score, graph edge or eligibility. */
export function workReceipt(
  call: ToolCall,
  value: unknown,
): WorkReceipt | undefined {
  const v = object(value);
  if (!v || v.error !== undefined) return;
  let summary: Record<string, unknown>;
  switch (call.function.name) {
    case "input_history_list":
      if (!Array.isArray(v.entries)) return;
      summary = {
        ...pick(v, [
          "snapshotHash",
          "totalTurns",
          "matchedTurns",
          "nextOffset",
        ]),
        entries: list(
          v.entries,
          (e) =>
            pick(e, [
              "sourceId",
              "inputVersion",
              "textHash",
              "totalChars",
              "resumeReplaced",
              "constraintsReplaced",
            ]),
          20,
        ),
      };
      break;
    case "input_history_read":
      if (!v.evidence) return;
      summary = {
        ...pick(v, [
          "sourceId",
          "snapshotHash",
          "inputVersion",
          "textHash",
          "offset",
          "end",
          "totalChars",
          "nextOffset",
        ]),
        rereadForExactQuotation: true,
        routingNote:
          "Read positions are a directory, not evidence. Do not re-read unchanged pages merely to plan; experts can inspect their own source details. Re-read the original when exact wording is needed.",
      };
      break;
    case "graph_paths":
      if (!Array.isArray(v.paths)) return;
      summary = {
        mode: v.mode,
        calculationEvidenceId: v.evidence?.id,
        paths: list(
          v.paths,
          (p) => ({
            ...pick(p, ["routeId", "nodes", "cost"]),
            edgeEvidenceIds: Array.isArray(p.evidence)
              ? p.evidence.map((e: any) => e.id)
              : [],
          }),
          10,
        ),
      };
      break;
    case "categories_search":
      if (!Array.isArray(v.hits)) return;
      summary = {
        hits: list(
          v.hits,
          (h) => ({
            categoryId: h.categoryId,
            evidenceId: h.evidence?.id,
            evidenceVersion: h.evidence?.version,
          }),
          10,
        ),
      };
      break;
    case "jobs_search":
      if (
        !v.counts ||
        !Array.isArray(v.eligible) ||
        !Array.isArray(v.uncertain)
      )
        return;
      summary = {
        ...pick(v, [
          "counts",
          "constraintVersion",
          "dataScope",
          "interpretation",
          "mode",
        ]),
        calculationEvidenceId: v.evidence?.id,
        eligible: list(v.eligible, (h) => ({
          jobId: h.jobId,
          evidenceId: h.evidence?.id,
          evidenceVersion: h.evidence?.version,
        })),
        uncertain: list(v.uncertain, (h) => ({
          jobId: h.jobId,
          evidenceId: h.evidence?.id,
          unknowns: h.unknowns,
        })),
        categoryCoverage: list(v.categoryCoverage, (c) => ({ ...c }), 10),
      };
      break;
    case "jobs_check":
      if (!Array.isArray(v.results)) return;
      summary = {
        dataScope: v.dataScope,
        results: list(v.results, (r) =>
          pick(r, [
            "id",
            "eligible",
            "checks",
            "violations",
            "unknowns",
            "matchedSkills",
            "missingSkills",
            "overlap",
          ]),
        ),
      };
      break;
    default:
      return;
  }
  let args: unknown;
  try {
    args = JSON.parse(call.function.arguments);
  } catch {
    return;
  }
  return {
    key: hash([call.function.name, args]),
    tool: call.function.name,
    arguments: args,
    resultHash: hash(value),
    summary,
  };
}

export class WorkingSet {
  private entries = new Map<string, WorkReceipt>();
  private excluded = 0;
  constructor(readonly taskHash: string) {}
  restore(content: string) {
    if (!content.startsWith(WORKING_SET_PREFIX)) return;
    try {
      const v = JSON.parse(content.slice(WORKING_SET_PREFIX.length));
      if (v.taskHash !== this.taskHash || !Array.isArray(v.entries)) return;
      this.excluded +=
        Number.isSafeInteger(v.omittedReceiptCount) && v.omittedReceiptCount > 0
          ? v.omittedReceiptCount
          : 0;
      for (const e of v.entries) {
        if (
          typeof e?.tool !== "string" ||
          typeof e.resultHash !== "string" ||
          !object(e.summary) ||
          e.key !== hash([e.tool, e.arguments])
        )
          continue;
        this.add(e);
      }
    } catch {
      /* Invalid or old context cannot become a working receipt. */
    }
  }
  add(entry: WorkReceipt) {
    this.entries.delete(entry.key);
    this.entries.set(entry.key, entry);
  }
  /** Keep tool variety before older variants. Omit whole records, never JSON tails. */
  message(tokenLimit: number): Message | undefined {
    if (!this.entries.size && !this.excluded) return;
    const recent = [...this.entries.values()].reverse();
    const hasPaths = (e: WorkReceipt) =>
      e.tool === "graph_paths" &&
      Number(
        (e.summary.paths as { returnedCount?: number } | undefined)
          ?.returnedCount ?? 0,
      ) > 0;
    // A later empty outgoing-edge query must not evict an already found route.
    const candidates = [...recent].sort((a, b) => {
      const rank = (e: WorkReceipt) =>
        hasPaths(e) ? (object(e.arguments)?.target ? 0 : 1) : 2;
      return rank(a) - rank(b);
    });
    const latestTools = new Set<string>();
    const first: WorkReceipt[] = [],
      rest: WorkReceipt[] = [];
    for (const e of candidates) {
      if (latestTools.has(e.tool)) rest.push(e);
      else {
        first.push(e);
        latestTools.add(e.tool);
      }
    }
    const chosen: WorkReceipt[] = [];
    const make = () => ({
      role: "user" as const,
      content:
        WORKING_SET_PREFIX +
        JSON.stringify({
          taskHash: this.taskHash,
          entries: [...chosen].reverse(),
          omittedReceiptCount: this.excluded + recent.length - chosen.length,
          instruction:
            "Continue from completed results. To reread details use the recorded tool/arguments under current permissions. Summaries grant no evidence access. Counts cover the selected corpus, not the market. Omitted is unknown, not empty.",
        }),
    });
    // Graph discovery and deterministic checks are harder to reconstruct from
    // raw evidence snippets than search entry points; preserve them first.
    const priority = [
      "graph_paths",
      "jobs_check",
      "jobs_search",
      "categories_search",
    ];
    first.sort((a, b) => priority.indexOf(a.tool) - priority.indexOf(b.tool));
    if (estimateTokens(JSON.stringify(make())) > tokenLimit)
      throw new RuntimeLimitError(
        "context_limit",
        "Required working-set omission notice exceeds available context",
      );
    for (const e of [...first, ...rest]) {
      if (chosen.length >= 16) break;
      chosen.push(e);
      if (estimateTokens(JSON.stringify(make())) > tokenLimit) chosen.pop();
    }
    if (
      recent.some((e) => e.tool === "graph_paths") &&
      !chosen.some((e) => e.tool === "graph_paths")
    )
      throw new RuntimeLimitError(
        "context_limit",
        "Required graph working result exceeds available context",
      );
    if (recent.some(hasPaths) && !chosen.some(hasPaths))
      throw new RuntimeLimitError(
        "context_limit",
        "Required discovered path cannot be replaced by a later empty search",
      );
    return make();
  }
}
