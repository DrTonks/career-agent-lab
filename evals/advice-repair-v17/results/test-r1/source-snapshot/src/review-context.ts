/** Optional read-only extension data. Review questions are control hints, never evidence. */
export interface ReviewContext {
  schemaVersion: "memory-probe-integration-v1";
  historicalArtifactAccess?: boolean;
  derivationChecks?: Array<Record<string, unknown>>;
  catalog: Array<{ id: string; title: string }>;
  priorConclusions: Array<{ id: string; role: string; version: number; summary: string }>;
  tasks: Array<{
    key: string;
    question: string;
    targets: string[];
    refs: string[];
    binding: Record<string, unknown>;
    status: string;
    requestedEvidence?: string[];
  }>;
}
export function expertReviewContext(context: ReviewContext | undefined, role: string) {
  return context ? {
    schemaVersion: context.schemaVersion,
    notice: "复查问题和旧结论不是事实证据。根据当前任务读取授权原件，独立核定并更新自己的产物。",
    catalog: context.catalog,
    derivationChecks: context.derivationChecks,
    priorConclusions: context.priorConclusions.filter(c => c.role === role),
    tasks: context.tasks.filter(t => t.targets.includes(role)).map(({ key, question, targets, refs, binding, status, requestedEvidence }) => ({ key, question, targets, refs, binding, status, requestedEvidence })),
  } : undefined;
}
