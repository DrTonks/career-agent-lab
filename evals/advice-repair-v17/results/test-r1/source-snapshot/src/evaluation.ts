import { Store } from "./storage.js";
export function runMetrics(store: Store, id: string) {
  const run = store.run(id),
    calls = store.modelCalls(id),
    events = store.events(id),
    artifacts = store.artifacts(id);
  const usage = calls.map(
    (c) =>
      c.usage as
        | {
            input: number | null;
            output: number | null;
            cachedInput: number | null;
          }
        | undefined,
  );
  const total = (key: "input" | "output" | "cachedInput") =>
    usage.some((u) => u?.[key] === null || u?.[key] === undefined)
      ? null
      : usage.reduce((s, u) => s + u![key]!, 0);
  const spans = events
    .filter((e) => e.type === "run.resources")
    .map(
      (e) =>
        e.payload as {
          durationMs: number;
          peakRssBytes: number;
          cpu: { user: number; system: number };
        },
    );
  return {
    runId: id,
    architecture: run.request.architecture,
    mode: run.mode,
    model: calls[0]?.model ?? null,
    status: run.status,
    datasetVersion: run.datasetVersion,
    modelCalls: calls.length,
    finalReview: run.finalReview ?? null,
    finalReviewModelCalls: calls.filter((c) =>
      String(c.scope).startsWith("final-review:"),
    ).length,
    finalRevisionModelCalls: calls.filter((c) =>
      String(c.scope).startsWith("final-repair:"),
    ).length,
    recoveredModelReplies: events.filter((e) => e.type === "model.recovered")
      .length,
    interruptedModelCalls: calls.filter((c) => c.status === "interrupted")
      .length,
    streamFrames: events.filter((e) => e.type === "model.stream").length,
    streamJournalPayloadBytes: events
      .filter((e) => e.type === "model.stream")
      .reduce(
        (sum, e) => sum + Buffer.byteLength(JSON.stringify(e.payload)),
        0,
      ),
    inputTokens: total("input"),
    outputTokens: total("output"),
    cachedInputTokens: total("cachedInput"),
    unknownUsageCalls: usage.filter(
      (u) => u?.input == null || u?.output == null,
    ).length,
    durationMs: spans.reduce((s, x) => s + x.durationMs, 0),
    peakRssBytes: Math.max(0, ...spans.map((x) => x.peakRssBytes)),
    cpuMicroseconds: spans.reduce((s, x) => s + x.cpu.user + x.cpu.system, 0),
    toolCalls: events.filter((e) => e.type === "tool.started").length,
    toolFailures: events.filter((e) => e.type === "tool.failed").length,
    toolArgumentFailures: events.filter(
      (e) => e.type === "tool.arguments_rejected",
    ).length,
    expertCalls: events.filter((e) => e.type === "expert.started").length,
    collaborationRequests: store
      .artifactHistory(id)
      .filter((h) => h.artifact.result.collaboration).length,
    coordinationDecisions: events.filter(
      (e) => e.type === "coordination.committed",
    ).length,
    invalidatedArtifacts: store
      .artifactHistory(id)
      .filter((h) => h.invalidatedBy).length,
    repairedSteps: artifacts.filter((a) => (a.attempt ?? 1) > 1).length,
    failedAttempts: store
      .artifactHistory(id)
      .filter((h) => h.artifact.result.status === "failed")
      .map((h) => ({
        stepId: h.artifact.stepId,
        attempt: h.artifact.attempt ?? 1,
        failure: h.artifact.failure ?? null,
        invalidated: !!h.invalidatedBy,
      })),
    communicationBytes: events
      .filter((e) => ["expert.started", "expert.completed"].includes(e.type))
      .reduce(
        (s, e) =>
          s +
          Number(
            (e.payload as any).requestBytes ??
              (e.payload as any).resultBytes ??
              0,
          ),
        0,
      ),
    artifacts: artifacts.map((a) => ({
      expert: a.expert,
      attempt: a.attempt ?? 1,
      status: a.result.status,
      evidenceCount: a.result.evidenceIds.length,
    })),
    evaluationNote:
      "Operational metrics only. Task quality needs independent labels/blind review; replay is not model quality.",
  };
}
