import type { Artifact, Role, RunRecord } from "./contracts.js";
import type { Store } from "./storage.js";

/** Expose ancestor outputs as historical claims, without granting their old sources. */
export function historicalReviewArtifacts(
  store: Store,
  run: RunRecord,
): Artifact[] {
  const latest = new Map<Role, Artifact>();
  const visited = new Set<string>([run.id]);
  let parentId = run.continuation?.parentRunId;
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = store.run(parentId, run.request.userId);
    if (parent.request.conversationId !== run.request.conversationId)
      throw Error("Historical review conversation mismatch");
    if (!["succeeded", "partial"].includes(parent.status)) break;
    for (const a of store.artifacts(parent.id)) {
      if (
        latest.has(a.expert) ||
        a.failure ||
        !["succeeded", "partial"].includes(a.result.status)
      )
        continue;
      latest.set(a.expert, {
        ...a,
        publishedEvidence: [],
        reuse: { sourceArtifactId: a.id, policy: "historical-review-v1" },
        result: {
          ...a.result,
          summary: "【历史产物，尚未针对本轮验证】" + a.result.summary,
          nextActions: [
            "仅作为历史结论。依据当前输入核定是否仍适用；原引用不授予访问或免查权限，须重新读取当前授权原件。",
            ...a.result.nextActions,
          ],
        },
      });
    }
    parentId = parent.continuation?.parentRunId;
  }
  return [...latest.values()];
}
