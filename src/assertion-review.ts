import { z } from "zod";
import type { Artifact, Request } from "./contracts.js";

// UTF-16 offsets refer to the unmodified draft; whitespace is not an assertion.
// No truncation: an overlarge inspection fails closed at the schema/model boundary.
export function reviewUnits(draft: string) {
  return [...draft.matchAll(/[^\r\n。！？!?]+[。！？!?]?|[。！？!?]/gu)]
    .filter((m) => m[0].trim())
    .map((m, id) => ({
      id,
      start: m.index!,
      end: m.index! + m[0].length,
      text: m[0],
    }));
}
export type ReviewSource = {
  id: string;
  kind: string;
  text: string;
  origin?: { sourceId: string; version: string; artifactId: string };
  alsoPublishedAs?: { sourceId: string; version: string; artifactId: string }[];
  window?: { parentId: string; start: number; end: number; total: number };
};
export function reviewSources(
  request: Request,
  artifacts: Artifact[],
  facts: unknown,
  standards: { id: string; text: string }[],
): ReviewSource[] {
  const sources: ReviewSource[] = [
    { id: "facts", kind: "control", text: JSON.stringify(facts) },
    { id: "request", kind: "request", text: request.request },
    {
      id: "constraints",
      kind: "request",
      text: JSON.stringify(request.constraints),
    },
    { id: "resume", kind: "resume", text: request.resumeText },
    ...standards.map((s) => ({ ...s, kind: "rule" })),
    ...artifacts.map((a) => ({
      id: `result:${a.stepId}`,
      kind: "artifact",
      text: JSON.stringify(a.result),
    })),
  ];
  const seen = new Set<string>();
  let n = 0;
  for (const a of artifacts)
    for (const e of a.publishedEvidence ?? []) {
      // Only evidence actually read by a producing expert. Preserve disjoint pages.
      for (const text of e.readTexts ?? [e.text]) {
        const identity = JSON.stringify([e.sourceId, e.version, text]);
        if (!text || seen.has(identity)) continue;
        seen.add(identity);
        const same = sources.find((s) => s.kind === e.kind && s.text === text);
        if (same) {
          (same.alsoPublishedAs ??= []).push({
            sourceId: e.sourceId,
            version: e.version,
            artifactId: a.id,
          });
          continue;
        }
        sources.push({
          id: `e${n++}`,
          kind: e.kind,
          text,
          origin: {
            sourceId: e.sourceId,
            version: e.version,
            artifactId: a.id,
          },
        });
      }
    }
  return sources;
}
const Citation = z
  .object({ sourceId: z.string(), quote: z.string().min(1).max(500) })
  .strict();
export function resolveCitation(
  quote: string,
  source: ReviewSource | undefined,
) {
  if (source?.text.includes(quote))
    return { quote, representation: "literal" as const };
  if (source) {
    try {
      const decoded: unknown = JSON.parse(`"${quote}"`);
      if (
        typeof decoded === "string" &&
        decoded &&
        source.text.includes(decoded)
      )
        return { quote: decoded, representation: "json-escaped" as const };
    } catch {
      /* No valid exact decoded representation. */
    }
  }
  return null;
}
export const REVIEW_MAX_CITATIONS = 12;
export const AssertionAudit = z
  .object({
    units: z
      .array(
        z
          .object({
            unitIds: z.array(z.number().int().nonnegative()).min(1).max(160),
            kind: z.enum([
              "personal",
              "absence",
              "qualification",
              "execution",
              "scope",
              "question",
              "evidence_status",
              "advice",
              "presentation",
            ]),
            verdict: z.enum([
              "supported",
              "unsupported",
              "contradicted",
              "nonfactual",
            ]),
            citations: z.array(Citation).max(REVIEW_MAX_CITATIONS),
            reason: z.string().max(400),
          })
          .strict(),
      )
      .max(160),
    changes: z
      .array(
        z
          .object({
            unitId: z.number().int().nonnegative(),
            field: z.enum([
              "education",
              "experienceYears",
              "skills",
              "cities",
              "minMonthlySalary",
              "weekendsOff",
              "targetCategory",
              "pathMode",
            ]),
            operation: z.enum(["relax", "correct", "develop"]),
          })
          .strict(),
      )
      .max(40),
    hardConditionCounts: z
      .array(
        z
          .object({
            unitId: z.number().int().nonnegative(),
            count: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .max(20),
  })
  .strict();

export function inspectAssertions(
  draft: string,
  audit: z.infer<typeof AssertionAudit>,
  sources: ReviewSource[],
  activeHardConditionCount: number,
  selectedIds?: number[],
) {
  const allUnits = reviewUnits(draft);
  const units = selectedIds
    ? allUnits.filter((u) => selectedIds.includes(u.id))
    : allUnits;
  if (
    selectedIds &&
    (units.length !== selectedIds.length ||
      new Set(selectedIds).size !== selectedIds.length)
  )
    throw Error("Invalid selected review unit IDs");
  const ids = new Set(audit.units.flatMap((a) => a.unitIds));
  if (
    audit.units.flatMap((a) => a.unitIds).length !== units.length ||
    ids.size !== units.length ||
    units.some((u) => !ids.has(u.id))
  )
    throw Error(
      "Final assertion audit must cover every draft unit exactly once",
    );
  const problems: string[] = [];
  const submissionErrors: string[] = [];
  for (const a of audit.units) {
    const unit = {
      text: a.unitIds.map((id) => allUnits[id]!.text).join(" / "),
    };
    for (const citation of a.citations) {
      const source = sources.find((s) => s.id === citation.sourceId);
      if (!resolveCitation(citation.quote, source))
        throw Error(
          `Final assertion citation absent from source: ${citation.sourceId}`,
        );
    }
    if (a.verdict === "unsupported" || a.verdict === "contradicted")
      problems.push(
        `${unit.text}: ${a.verdict}: ${a.reason || "No supported basis"}`,
      );
    if (a.verdict === "supported" && !a.citations.length)
      submissionErrors.push(
        `${unit.text}: supported assertion requires an exact source citation`,
      );
    if (
      a.verdict === "nonfactual" &&
      !["advice", "presentation", "question"].includes(a.kind)
    )
      problems.push(
        `${unit.text}: factual assertions cannot bypass grounding as nonfactual`,
      );
    if (
      a.kind === "question" &&
      (a.verdict !== "nonfactual" ||
        a.unitIds.some(
          (id) => !allowsQuestionClassification(allUnits[id]!.text),
        ))
    )
      submissionErrors.push(
        `${unit.text}: question classification cannot carry an asserted personal premise or a factual verdict; reclassify and ground factual clauses without editing the draft`,
      );
    if (
      a.kind === "evidence_status" &&
      a.unitIds.some(
        (id) => !allowsEvidenceStatusClassification(allUnits[id]!.text),
      )
    )
      submissionErrors.push(
        `${unit.text}: evidence_status cannot infer a personal capability or absence; reclassify the assertion and check primary evidence without editing the draft`,
      );
    if (
      ["personal", "absence"].includes(a.kind) &&
      a.verdict === "supported" &&
      !a.citations.some((c) =>
        ["resume", "request", "memory"].includes(
          sources.find((s) => s.id === c.sourceId)!.kind,
        ),
      )
    )
      submissionErrors.push(
        `${unit.text}: personal/absence claim needs primary user evidence, not only an expert conclusion or rubric`,
      );
  }
  if (submissionErrors.length)
    throw new Error(
      `review_classification_invalid: ${JSON.stringify(submissionErrors)}. Recheck every listed classification and source. If the claim is an output/rule state, classify it accordingly; if personal, cite primary user evidence or mark unsupported. Do not edit the draft or invent support.`,
    );
  for (const change of audit.changes) {
    const unit = units.find((u) => u.id === change.unitId);
    if (!unit) throw Error("Final assertion change references an unknown unit");
    if (
      change.operation === "relax" &&
      ["education", "experienceYears", "skills"].includes(change.field)
    )
      problems.push(
        `${unit.text}: applicant fact ${change.field} cannot be relaxed to qualify for a position; correction and future development are distinct`,
      );
  }
  for (const claim of audit.hardConditionCounts) {
    const unit = units.find((u) => u.id === claim.unitId);
    if (!unit) throw Error("Final condition count references an unknown unit");
    if (claim.count !== activeHardConditionCount)
      problems.push(
        `${unit.text}: requested hard condition count=${activeHardConditionCount}, draft=${claim.count}; skill overlap and not_requested checks are not additional hard filters`,
      );
  }
  return problems;
}

/** Negative counterexample guard, not a whitelist of all valid question forms. */
export function allowsQuestionClassification(text: string) {
  return !assertedPersonalPremise(text);
}

function assertedPersonalPremise(text: string) {
  return text
    .replaceAll("**", "")
    .replaceAll("`", "")
    .split(
      /[，,；;。！!\n]|(?:但是|但|不过|然而|并且|而且|因此|所以|因为|由于|鉴于|同时|另外|此外|反而|且|却)/u,
    )
    .some((clause) => {
      // A bounded epistemic clause does not assert its embedded proposition.
      // Split adversative/causal clauses first, so a later personal assertion
      // is still checked. Deliberately exclude double negation (并非不能确认).
      const plain = clause.trim().replace(/^(?:[-*+]\s+|\d+[.)]\s+)/u, "");
      // Denying an inference about the person is not asserting its conclusion.
      // Keep this anchored and bounded: double negation and a separate personal
      // assertion must still be classified with primary user evidence.
      if (
        /^(?:(?:这|那|它|上述情况|上述结果|材料不足|材料缺失|证据不足|证据缺失|信息不足)\s*)?(?:也|仍)?\s*(?:不代表|不意味着|不表示|不等于|不能说明|不足以说明)\s*(?:你|您|用户|该学生)/u.test(
          plain,
        ) &&
        (plain.match(/(?:你|您|用户|该学生)/gu)?.length ?? 0) === 1
      )
        return false;
      if (
        /^(?:(?:当前|目前|现阶段|现在|暂时|本次|仍|也|既|还|我们|我|系统|根据现有材料|依据现有材料)\s*)*(?:(?:不能|无法|尚不能|暂不能|未能|尚未|未|难以|不足以)(?:确认|判断|认定|证明|断定)|(?:没有|缺乏|尚无)(?:充分)?(?:证据|材料)(?:可以)?(?:表明|证明|支持))/u.test(
          plain,
        )
      )
        return false;
      // "你有实习吗" asks, whereas an earlier "你没有实习，...吗" still asserts.
      if (
        /(?:吗[？?]?|[？?])\s*$/u.test(clause) ||
        /^\s*(?:如果|假如|若|假设)/u.test(clause)
      )
        return false;
      const declarative = clause.replace(
        /(?:你|您|用户|该学生)(?:目前|现在)?(?:有|具备|掌握|熟悉|是)(?:哪些|什么|多少|哪种|谁|几)/gu,
        "",
      );
      return /(?:你|您|用户|该学生)(?:目前|现在)?(?:已经|曾经|已|没有|不会|具备|缺乏|熟悉|熟练|掌握|是(?!否)|有(?!没有))/u.test(
        declarative,
      );
    });
}
export function allowsEvidenceStatusClassification(text: string) {
  return (
    !assertedPersonalPremise(text) &&
    !/(?:因此|所以|这(?:就)?说明|由此可见)[，,：:\s]*(?:(?:你|您|用户|其)(?:的)?)?(?:不会|没有(?:专业)?能力|缺乏(?:专业)?能力|能力(?:低|弱|不足|为零))/u.test(
      text,
    )
  );
}

/** Advisory only. These hints neither establish truth nor change source ACLs. */
export function classificationGuidance(units: { id: number; text: string }[]) {
  return units.flatMap((unit) =>
    /(?:null|证据不足|尚未核验|材料完整度|材料(?:不足|缺失)|未用低分|(?:不能|无法|尚未|未能)(?:确认|判断|认定|证明))/iu.test(
      unit.text,
    ) && allowsEvidenceStatusClassification(unit.text)
      ? [
          {
            unitId: unit.id,
            candidateKind: "evidence_status" as const,
            instruction:
              "Check whether this unit describes recorded evidence/assessment state, rather than the person's actual capability or absence. For state claims cite the actual artifact/control result; a rubric alone cannot prove the current state. Mixed personal claims still need primary user evidence. This hint is not a verdict or a source: verify every clause, or mark unsupported/contradicted.",
          },
        ]
      : [],
  );
}
