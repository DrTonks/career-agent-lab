import { z } from "zod";
import { hash } from "./config.js";

/** Supported public rule vocabulary; unrecognized constraints must not be guessed. */
export const TimeRule = z.object({
  monthsAtLeast: z.number().nonnegative(),
  daysAtLeast: z.number().int().min(0).max(7),
  weeklyHoursAtLeast: z.number().min(0).max(168).optional(),
  qualifyingDays: z.object({ count: z.number().int().min(1).max(7), hoursAtLeast: z.number().min(0).max(24) }).strict().optional(),
  everyWorkingDayHoursAtLeast: z.number().min(0).max(24).optional(),
}).strict();
export type TimeRule = z.infer<typeof TimeRule>;
export type TimeFacts = { months: number | null; dailyHours: Record<string, number> };

export function evaluateTimeRule(raw: unknown, facts: TimeFacts) {
  const rule = TimeRule.parse(raw);
  const hours = Object.values(facts.dailyHours);
  if (hours.length !== 7 || hours.some(h => !Number.isFinite(h) || h < 0 || h > 24) ||
      (facts.months !== null && (!Number.isFinite(facts.months) || facts.months < 0)))
    throw Error("Incomplete or invalid time facts");
  const working = hours.filter(h => h > 0), weekly = hours.reduce((a, b) => a + b, 0);
  const checks: Array<{ predicate: string; actual: number | null; required: number; satisfied: boolean | null }> = [
    { predicate: "monthsAtLeast", actual: facts.months, required: rule.monthsAtLeast, satisfied: facts.months === null ? null : facts.months >= rule.monthsAtLeast },
    { predicate: "daysAtLeast", actual: working.length, required: rule.daysAtLeast, satisfied: working.length >= rule.daysAtLeast },
  ];
  if (rule.weeklyHoursAtLeast !== undefined)
    checks.push({ predicate: "weeklyHoursAtLeast", actual: weekly, required: rule.weeklyHoursAtLeast, satisfied: weekly >= rule.weeklyHoursAtLeast });
  if (rule.qualifyingDays) {
    const count = hours.filter(h => h > 0 && h >= rule.qualifyingDays!.hoursAtLeast).length;
    checks.push({ predicate: `count(workingDayHours>=${rule.qualifyingDays.hoursAtLeast})`, actual: count, required: rule.qualifyingDays.count, satisfied: count >= rule.qualifyingDays.count });
  }
  if (rule.everyWorkingDayHoursAtLeast !== undefined) {
    const minimum = working.length ? Math.min(...working) : null;
    checks.push({ predicate: "everyWorkingDayHoursAtLeast", actual: minimum, required: rule.everyWorkingDayHoursAtLeast, satisfied: working.every(h => h >= rule.everyWorkingDayHoursAtLeast!) });
  }
  const verdict = checks.some(c => c.satisfied === false) ? "不符" : checks.some(c => c.satisfied === null) ? "待核定" : "符合";
  return { verdict, checks, weeklyHours: weekly };
}

export function verifyTimeRefutation(input: {
  jobId: string; rule: unknown; ruleVersion: string; factsVersion: string;
  before: TimeFacts; after: TimeFacts;
  proposal: { jobId: string; ruleVersion: string; factsVersion: string; predictedAfter: string; claimsRefutation: boolean };
}) {
  const rule = TimeRule.parse(input.rule), p = input.proposal;
  if (input.ruleVersion !== hash(rule) || p.ruleVersion !== input.ruleVersion || p.factsVersion !== input.factsVersion || p.jobId !== input.jobId)
    return { status: "binding-rejected", valid: false };
  const before = evaluateTimeRule(rule, input.before), after = evaluateTimeRule(rule, input.after);
  const decidable = before.verdict !== "待核定" && after.verdict !== "待核定";
  const changesDecision = decidable && before.verdict !== after.verdict;
  const valid = decidable && p.predictedAfter === after.verdict && p.claimsRefutation === changesDecision;
  return {
    status: !decidable ? "unresolved" : !valid ? "prediction-rejected" : changesDecision ? "verified-refutation" : "verified-non-refutation",
    valid, before, after, changesDecision,
    scope: "These public time rules only; hypothetical changes do not modify actual memory facts.",
  };
}
