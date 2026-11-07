import type { DatabaseSync } from "node:sqlite";
import type { RunRecord } from "./contracts.js";
import { hash } from "./config.js";
/** Closed scripted approval histories only; external user commands need their own
 * protocol. Later turns are excluded even when their records already exist. */
export function memoryReviewTimeline(
  db: DatabaseSync,
  chain: RunRecord[],
  index: number,
) {
  const run = chain[index];
  if (!run) throw Error("Unknown memory review turn");
  const userId = run.request.userId,
    turns = new Map(chain.map((r, i) => [r.id, i + 1]));
  const history = db
    .prepare(
      "SELECT body FROM memory_history WHERE user_id=? ORDER BY namespace,key,version",
    )
    .all(userId)
    .map((r) => JSON.parse(String(r.body)));
  const versions = new Map<string, number>(),
    items: any[] = [];
  for (const r of history) {
    const turn = turns.get(r.source),
      key = JSON.stringify([r.namespace, r.key]);
    if (
      r.userId !== userId ||
      turn === undefined ||
      r.actor !== "approved-proposal"
    )
      throw Error("Unrepresented memory source or external command");
    if (r.version !== (versions.get(key) ?? 0) + 1)
      throw Error("Memory review version gap");
    versions.set(key, r.version);
    const approvalRow = db
      .prepare("SELECT body FROM approvals WHERE run_id=?")
      .get(r.source);
    const approval = approvalRow ? JSON.parse(String(approvalRow.body)) : null;
    const proposals = db
      .prepare("SELECT id,body,status FROM proposals WHERE run_id=?")
      .all(r.source);
    const matches = proposals.filter((p) => {
      const v = JSON.parse(String(p.body));
      return (
        p.status === "approved" &&
        approval?.proposalIds?.includes(p.id) &&
        v.namespace === r.namespace &&
        v.key === r.key &&
        v.expectedVersion === r.version - 1 &&
        v.operation === r.operation &&
        (v.operation === "retract" ? r.value === null : v.value === r.value) &&
        hash(v.evidenceIds) === hash(r.evidenceIds)
      );
    });
    if (
      approval?.status !== "committed" ||
      approval?.decision !== "approve" ||
      matches.length !== 1
    )
      throw Error("Memory lacks a matching approved proposal");
    if (turn > index + 1) continue;
    if (r.updatedAt > run.updatedAt)
      throw Error("Memory was changed after the recorded turn");
    items.push({
      turn,
      namespace: r.namespace,
      key: r.key,
      version: r.version,
      operation: r.operation,
      value: r.value,
      expiresAt: r.expiresAt,
      evidenceIds: r.evidenceIds,
    });
  }
  const latest = new Map<string, any>();
  for (const r of items) latest.set(JSON.stringify([r.namespace, r.key]), r);
  const heads = [...latest.values()]
    .sort((a, b) =>
      a.namespace < b.namespace
        ? -1
        : a.namespace > b.namespace
          ? 1
          : a.key < b.key
            ? -1
            : a.key > b.key
              ? 1
              : 0,
    )
    .map((r) => ({
      namespace: r.namespace,
      key: r.key,
      version: r.version,
      expiresAt: r.expiresAt,
      state:
        r.operation === "retract"
          ? "retracted"
          : r.expiresAt && r.expiresAt <= run.updatedAt
            ? "expired"
            : "active",
    }));
  if (hash(heads) !== run.memorySnapshot)
    throw Error(
      "Memory review snapshot mismatch; cannot infer missing or time-sensitive state",
    );
  const decisions = chain.slice(0, index + 1).flatMap((r, i) => {
    const row = db
      .prepare("SELECT body FROM approvals WHERE run_id=?")
      .get(r.id);
    if (!row) return [];
    const a = JSON.parse(String(row.body));
    return [
      {
        turn: i + 1,
        status: a.status,
        decision: a.decision ?? null,
        proposalCount: a.proposalIds.length,
      },
    ];
  });
  return {
    schemaVersion: "memory-review-v1",
    turn: index + 1,
    items,
    heads,
    decisions,
    rule: "Recorded proposals and approval/version state only; memory contents remain user claims, not independent proof of capability. No future-turn or other-candidate history is included.",
  };
}
