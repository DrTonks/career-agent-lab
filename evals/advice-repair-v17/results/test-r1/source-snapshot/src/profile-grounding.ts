import type { Dimensions, Evidence, Request } from "./contracts.js";

export const PROFILE_GROUNDING_VERSION = "explicit-absence-context-v1";
type Dimension = (typeof Dimensions)[number];

// Deliberately dimension-wide: lacking one certificate/technology is not a
// zero for the whole certificate/professionalSkill dimension.
const concepts: Record<Dimension, string> = {
  professionalSkill: "专业技能|专业技术能力",
  certificate: "(?:任何)?(?:职业|专业|资格|相关)?证书|资格证",
  innovation: "创新能力|创新实践|创新经历",
  internalMotivation: "内驱力|内在动机|自主目标",
  learning: "学习能力|学习实践",
  stressTolerance: "抗压能力|压力应对经历",
  communication: "沟通能力|沟通实践",
  internship: "(?:(?:企业|公司)?实习)(?:经历|经验)?",
  language: "外语能力|外语使用经历",
  leadership: "领导经历|领导能力|组织管理经历",
  adaptability: "适应能力|情境调整经历",
  execution: "执行能力|任务执行经历",
};
const english: Partial<Record<Dimension, string>> = {
  internship: "(?:corporate |company )?internship(?: experience|s)?",
  certificate: "(?:professional )?certificat(?:es|ions)",
};

/** The original input supplies context, never permission for an unread quote. */
export function personalContext(
  evidence: Evidence,
  request: Request,
): string | null {
  if (evidence.kind === "resume") return request.resumeText;
  if (evidence.kind === "request") return request.request;
  if (evidence.kind === "memory") {
    // A memory's old provenance and metadata are not its current asserted value.
    for (const text of evidence.readTexts ?? [evidence.text]) {
      try {
        const value: unknown = JSON.parse(text)?.value;
        if (typeof value === "string") return value;
      } catch {
        /* A partial JSON page cannot establish the assertion's full context. */
      }
    }
  }
  return null;
}

/**
 * Admission of explicit absence, not a general entailment or truth verifier.
 * Unsupported phrasing requires clarification rather than a guessed zero.
 */
export function inspectExplicitAbsence(
  dimension: Dimension,
  quote: string,
  context: string | null,
) {
  const result = (accepted: boolean, reason: string, statement?: string) => ({
    version: PROFILE_GROUNDING_VERSION,
    dimension,
    accepted,
    reason,
    ...(statement === undefined ? {} : { statement }),
  });
  if (!context || !quote.trim() || !context.includes(quote))
    return result(false, "Complete personal assertion context is unavailable");
  if (
    /(?:示例|模板|假设|请(?:填写|输出|改写)|\b(?:example|template|hypothetical)\b)/iu.test(
      context,
    )
  )
    return result(
      false,
      "Example or hypothetical framing requires a separate personal clarification",
    );
  const concept = `(?:${concepts[dimension]})`;
  const statement = new RegExp(
    `^(?:(?:(?:我|本人)(?:目前|至今|迄今)?|目前|至今|迄今)?(?:暂无|尚无|没有|从未有过|未曾有过|从未有|从未参加过|未参加过|从未参加|未参加|未取得任何|没有取得任何|未取得|没有取得|不具备|无)${concept}|${concept}[：:]\\s*(?:暂无|无|没有))$`,
    "u",
  );
  const en = english[dimension]
    ? new RegExp(
        `^(?:I (?:currently )?(?:have no|have never had)|No) ${english[dimension]}$`,
        "iu",
      )
    : null;
  const positive = new RegExp(
    `(?:(?:已|曾|正在|开始|完成|参加|取得|拥有|具有|有过|有一段|有一次).{0,8}${concept}|${concept}.{0,8}(?:已完成|已取得|正在进行|[一二三四五六七八九十0-9]+个月))`,
    "u",
  );
  const sentences = context.split(/[。\r\n]+/u);
  const candidates: string[] = [];
  for (const sentence of sentences) {
    // Conditional, quoted/example, documentary and temporally superseded
    // statements do not establish current personal absence.
    if (
      /(?:如果|假如|假设|若|例如|示例|模板|写成|写为|请填|据说|以前|之前|去年|过去|曾经|后来|现在已经|未提及|未记录|未说明|没有记录|材料缺|\b(?:if|example|template|previously|before)\b|[“”「」"?？])/iu.test(
        sentence,
      )
    )
      continue;
    for (const raw of sentence.split(/[，,；;]/u)) {
      const clause = raw
        .trim()
        .replace(/^[-*]\s+/u, "")
        .replace(/\.$/u, "");
      if (
        quote.includes(clause) &&
        (statement.test(clause) || en?.test(clause))
      )
        candidates.push(clause);
    }
  }
  if (!candidates.length)
    return result(
      false,
      "Quote does not establish an unqualified current self-reported absence for this dimension; missing records, other people, examples and partial skill gaps are insufficient",
    );
  // Do not choose an absence clause over conflicting evidence in the same input.
  if (
    sentences.some((s) =>
      positive.test(candidates.reduce((rest, c) => rest.replaceAll(c, ""), s)),
    )
  )
    return result(
      false,
      "The personal input contains potentially conflicting experience; clarify its time and scope before assigning zero",
    );
  return result(
    true,
    "Explicit dimension-wide absence statement found in personal context; self-report is not independently verified",
    candidates[0],
  );
}
