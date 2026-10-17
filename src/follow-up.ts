import { hash } from "./config.js";
import {
  Request,
  type Artifact,
  type Continuation,
  type FollowUp,
  type Role,
  type RunRecord,
} from "./contracts.js";

/** Only user-origin text is carried into the next readable request source. */
export function followUpInput(
  parent: RunRecord,
  reply: FollowUp,
  artifacts: Artifact[],
  version: Continuation["version"] = "user-reply-v2",
  questionPolicy: "complete-open-questions-v1" | "legacy" = version ===
  "user-reply-v2"
    ? "complete-open-questions-v1"
    : "legacy",
) {
  const request = Request.parse({
    ...parent.request,
    request:
      version === "user-reply-v1"
        ? `此前用户任务及陈述（历史，本轮明确更正优先）：\n${parent.request.request}\n\n本轮用户回复：\n${reply.reply}`
        : reply.reply,
    resumeText: reply.resumeText ?? parent.request.resumeText,
    constraints: reply.constraints ?? parent.request.constraints,
  });
  const questions: Continuation["questions"] = [];
  for (const a of artifacts) {
    if (a.runId !== parent.id)
      throw Error("Follow-up artifact belongs to another run");
    const ledger = a.result.artifact.openQuestions as
      { schemaVersion?: string; items?: unknown } | undefined;
    const texts =
      questionPolicy === "complete-open-questions-v1" &&
      ledger?.schemaVersion === "open-questions-v1" &&
      Array.isArray(ledger.items) &&
      ledger.items.every((t) => typeof t === "string")
        ? (ledger.items as string[])
        : a.result.unknowns;
    const seen = new Set<string>();
    for (const text of texts) {
      const key = text.trim().replace(/\s+/gu, " ");
      if (questionPolicy !== "legacy" && seen.has(key)) continue;
      seen.add(key);
      questions.push({
        artifactId: a.id,
        expert: a.expert,
        kind: "unknown",
        text,
      });
    }
    if (a.result.collaboration?.kind === "user_input")
      questions.push({
        artifactId: a.id,
        expert: a.expert,
        kind: "user_input",
        text: a.result.collaboration.question,
      });
  }
  const body = {
    version,
    ...(questionPolicy !== "legacy" ? { questionPolicy } : {}),
    parentRunId: parent.id,
    operationId: reply.operationId,
    parentRequestHash: hash(parent.request),
    requestHash: hash(request),
    reply: reply.reply,
    resumeReplaced: reply.resumeText !== undefined,
    constraintsReplaced: reply.constraints !== undefined,
    questions,
  };
  return { request, continuation: { ...body, snapshotHash: hash(body) } };
}

/** Frozen routing context, never personal evidence or permission to old sources. */
export function continuationContext(run: RunRecord, role?: Role) {
  if (!run.continuation) return undefined;
  const { snapshotHash, ...body } = run.continuation;
  if (hash(body) !== snapshotHash || hash(run.request) !== body.requestHash)
    throw Error(
      "Follow-up snapshot changed; original immutable context required",
    );
  return {
    parentRunId: body.parentRunId,
    version: body.version,
    historyAccess:
      "Use input_history_list/read for original earlier user turns; the current request may contain only this turn. Directory and summaries are not read evidence. Later explicit corrections and current structured constraints take precedence.",
    inputVersion: run.inputVersion,
    questions: body.questions
      .map((q, index) => ({
        ...q,
        questionId: `question:${hash([snapshotHash, index, q])}`,
      }))
      .filter((q) => role === undefined || q.expert === role),
    rule: "Historical questions/unknowns are assistant context, not user facts. Read current request and resume completely, then use clarification_update to reconcile each in-scope question before expert_finish. A compound question may be partially answered: retain known fields with exact citations and ask only for remaining fields. Do not repeat an old missing-information label as a new fact. Explicit current corrections override history; unresolved contradictions require clarification. No prior assistant answer or private expert history is included.",
  };
}
