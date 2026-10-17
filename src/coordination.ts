import { z } from "zod";
import { Artifact, Plan, Role, validatePlan } from "./contracts.js";

// The same information-flow policy applies to both architectures.
export const allowedInputs: Record<Role, Role[]> = {
  profile: ["profile"],
  match: ["profile", "match"],
  path: ["profile", "match", "path"],
  report: ["profile", "match", "path", "report"],
};
export const CoordinationDecision = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("revise"),
      reason: z.string().min(1).max(2000),
      plan: Plan,
      targetStepId: z.string().optional(),
    })
    .strict(),
  z
    .object({ action: z.literal("defer"), reason: z.string().min(1).max(2000) })
    .strict(),
]);
export type CoordinationDecision = z.infer<typeof CoordinationDecision>;
export interface CoordinationTransition {
  plan: Plan;
  invalidatedStepIds: string[];
  attempts: Record<string, number>;
  targetStepId?: string;
}

export function validateExecutionPlan(input: unknown): Plan {
  const plan = validatePlan(input);
  const byId = new Map(plan.steps.map((s) => [s.id, s]));
  for (const step of plan.steps)
    if (
      step.dependsOn.some(
        (id) => !allowedInputs[step.expert].includes(byId.get(id)!.expert),
      )
    )
      throw new Error(
        "Plan dependency violates expert information-flow policy",
      );
  return plan;
}

/** Validate a replacement plan before any database mutation or model execution. */
export function revisePlan(
  current: Plan,
  proposed: unknown,
  requestArtifact: Artifact,
  artifacts: Artifact[],
  attempts: Record<string, number>,
  maxAttempts: number,
  resolvedTargetId?: string,
): CoordinationTransition {
  const plan = validateExecutionPlan(proposed);
  const request = requestArtifact.result.collaboration;
  if (!request || request.kind === "user_input")
    throw new Error(
      "This request requires user input, not automatic replanning",
    );
  const byId = new Map(plan.steps.map((s) => [s.id, s]));
  for (const old of current.steps) {
    const next = byId.get(old.id);
    if (!next || next.expert !== old.expert)
      throw new Error(
        "Replanning cannot remove steps or change their expert identity",
      );
  }
  const requester = byId.get(requestArtifact.stepId);
  if (
    request.targetStepId &&
    resolvedTargetId &&
    request.targetStepId !== resolvedTargetId
  )
    throw new Error("Cannot redirect a request for a specific step");
  const candidates = plan.steps.filter(
    (s) => s.id !== requestArtifact.stepId && s.expert === request.targetRole,
  );
  const targetId =
    request.targetStepId ??
    resolvedTargetId ??
    (candidates.length === 1 ? candidates[0]!.id : undefined);
  const target = targetId ? byId.get(targetId) : undefined;
  if (
    !requester ||
    !target ||
    (request.targetRole && target.expert !== request.targetRole) ||
    target.id === requester.id ||
    !allowedInputs[requester.expert].includes(target.expert)
  )
    throw new Error("Unauthorized collaboration target");
  if (!requester.dependsOn.includes(target.id))
    throw new Error("Requester must depend directly on the requested target");
  // Requests are explicit repair instructions, never evidence of their own truth.
  const changed = new Set<string>([requester.id, target.id]);
  for (const old of current.steps) {
    const next = byId.get(old.id)!;
    if (
      old.objective !== next.objective ||
      JSON.stringify([...old.dependsOn].sort()) !==
        JSON.stringify([...next.dependsOn].sort())
    )
      changed.add(old.id);
  }
  return {
    ...propagateInvalidation(
      current,
      plan,
      changed,
      artifacts,
      attempts,
      maxAttempts,
    ),
    targetStepId: target.id,
  };
}

export function retryFailedStep(
  plan: Plan,
  failure: Artifact,
  artifacts: Artifact[],
  attempts: Record<string, number>,
  maxAttempts: number,
): CoordinationTransition {
  if (!failure.failure?.retryable || failure.result.status !== "failed")
    throw new Error("Failure is not eligible for automatic retry");
  return propagateInvalidation(
    plan,
    plan,
    new Set([failure.stepId]),
    artifacts,
    attempts,
    maxAttempts,
  );
}

function propagateInvalidation(
  current: Plan,
  plan: Plan,
  changed: Set<string>,
  artifacts: Artifact[],
  attempts: Record<string, number>,
  maxAttempts: number,
): CoordinationTransition {
  // Use both old and new dependencies and actual artifact provenance. Removing
  // an edge from the new plan must not hide an old consumer of invalid evidence.
  let grew = true;
  while (grew) {
    const before = changed.size;
    for (const s of [...current.steps, ...plan.steps])
      if (s.dependsOn.some((d) => changed.has(d))) changed.add(s.id);
    const invalidIds = new Set(
      artifacts.filter((a) => changed.has(a.stepId)).map((a) => a.id),
    );
    for (const a of artifacts)
      if (a.inputArtifactIds?.some((id) => invalidIds.has(id)))
        changed.add(a.stepId);
    grew = changed.size > before;
  }
  const nextAttempts = { ...attempts };
  for (const id of changed) {
    if (!artifacts.some((a) => a.stepId === id)) continue;
    const next = (attempts[id] ?? 1) + 1;
    if (next > maxAttempts)
      throw new Error(`Step attempt limit exceeded: ${id}`);
    nextAttempts[id] = next;
  }
  return {
    plan,
    invalidatedStepIds: [...changed].sort(),
    attempts: nextAttempts,
  };
}
