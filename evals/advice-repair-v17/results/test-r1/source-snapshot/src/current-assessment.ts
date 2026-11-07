import { z } from "zod";

/** A current declaration is separate from explanatory/historical prose. */
export const CurrentAssessment = z.object({
  schemaVersion: z.literal("current-assessment-v1"),
  factsVersion: z.string().min(1),
  weeklyHours: z.number().min(0).max(168).nullable(),
  judgments: z.array(z.object({
    jobId: z.string().min(1),
    ruleVersion: z.string().min(1),
    verdict: z.enum(["符合", "不符", "待核定"]),
  }).strict()).max(20),
  evidenceIds: z.array(z.string()).min(1).max(80),
}).strict();
export type CurrentAssessment = z.infer<typeof CurrentAssessment>;

export function checkAssessmentBinding(
  value: unknown,
  expected: { factsVersion: string; weeklyHours: number | null; ruleVersions: Record<string, string>; evidenceIds: string[] },
) {
  const parsed = CurrentAssessment.safeParse(value);
  if (!parsed.success) return { valid: false, reason: "invalid-current-assessment" };
  const a = parsed.data;
  if (a.factsVersion !== expected.factsVersion)
    return { valid: false, reason: "stale-fact-version" };
  if (a.weeklyHours === null || a.weeklyHours !== expected.weeklyHours)
    return { valid: false, reason: "current-value-unresolved-or-mismatched" };
  if (a.evidenceIds.some(id => !expected.evidenceIds.includes(id)))
    return { valid: false, reason: "unread-assessment-evidence" };
  const ids = a.judgments.map(j => j.jobId);
  if (new Set(ids).size !== ids.length || ids.length !== Object.keys(expected.ruleVersions).length ||
      a.judgments.some(j => expected.ruleVersions[j.jobId] !== j.ruleVersion))
    return { valid: false, reason: "missing-or-stale-rule-binding" };
  return { valid: true, reason: null };
}
