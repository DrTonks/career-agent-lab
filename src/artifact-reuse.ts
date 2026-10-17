import { z } from "zod";
import { Artifact, Dimensions } from "./contracts.js";
import { hash } from "./config.js";
import { supportsQuote } from "./evidence.js";

/** Project only resume-supported profile fields; never carry old goal advice. */
export function profileFacts(
  source: Artifact,
  resumeText: string,
): Artifact | undefined {
  if (
    source.expert !== "profile" ||
    !["succeeded", "partial"].includes(source.result.status)
  )
    return;
  const schema = z.object({
    scores: z.record(z.string(), z.number().min(0).max(100).nullable()),
    skills: z.array(z.string()),
    evidence: z.array(
      z.object({
        dimension: z.enum(Dimensions),
        evidenceId: z.string(),
        quote: z.string().min(1),
      }),
    ),
  });
  const parsed = schema.safeParse(source.result.artifact);
  if (!parsed.success || Dimensions.some((d) => !(d in parsed.data.scores)))
    return;
  const published = (source.publishedEvidence ?? []).filter(
    (e) =>
      e.kind === "resume" &&
      e.version === hash(resumeText) &&
      [e.text, ...(e.readTexts ?? [])].every((text) =>
        resumeText.includes(text),
      ),
  );
  const citations = parsed.data.evidence.filter((e) =>
    published.some((p) => p.id === e.evidenceId && supportsQuote(p, e.quote)),
  );
  if (!published.length) return;
  // Scoring citations are not an exhaustive inventory of user facts. Preserve
  // published passages even when no dimension was assigned to them.
  const evidenceIds = [...new Set(published.map((e) => e.id))];
  const supported = new Set(citations.map((e) => e.dimension));
  return {
    ...source,
    id: `${source.id}:resume-facts-v2`,
    reuse: { sourceArtifactId: source.id, policy: "resume-facts-v2" },
    inputArtifactIds: [source.id],
    publishedEvidence: published,
    result: {
      status: "partial",
      summary:
        "保留同一简历已核验的画像事实与描述性分数；旧目标建议和岗位结论未沿用。",
      evidenceIds,
      unknowns: [
        "技能词和评分引用不是事实全集；判断缺失前须读取当前简历。原文旧偏好不是本轮约束，当前职业目标需重新判断",
      ],
      conflicts: [],
      nextActions: ["依据当前约束重新匹配岗位和路径"],
      artifact: {
        scores: Object.fromEntries(
          Dimensions.map((d) => [
            d,
            supported.has(d) ? parsed.data.scores[d] : null,
          ]),
        ),
        skills: parsed.data.skills.filter(
          (s) =>
            s.trim() &&
            published.some((e) =>
              (e.readTexts ?? [e.text]).some((text) =>
                text.toLowerCase().includes(s.toLowerCase()),
              ),
            ),
        ),
        evidence: citations,
        scoringVersion:
          typeof source.result.artifact.scoringVersion === "string"
            ? source.result.artifact.scoringVersion
            : "unknown-historical-version",
        sourceObservations: published.flatMap((e) =>
          (e.readTexts ?? [e.text]).map((quote) => ({
            evidenceId: e.id,
            quote,
            provenance:
              "User-provided resume excerpt, not independent verification or a current constraint",
          })),
        ),
      },
    },
  };
}
