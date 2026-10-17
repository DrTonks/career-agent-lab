import { z } from "zod";
import { hash } from "./config.js";
import { dimensions } from "./blind-review.js";

export const humanRubric = {
  version: "conversation-human-v1",
  dimensions,
  labels: [
    "事实与来源支持",
    "硬约束遵守",
    "任务完整性",
    "行动可执行性",
    "一致性与不确定性",
  ],
  anchors: [
    "关键错误或未满足要求",
    "较多重要问题",
    "部分满足，仍有实质缺口",
    "基本满足，少量欠缺",
    "充分满足当前任务",
  ],
  rules:
    "每张卡独立评价整段实际交付，按当前任务要求评分；不要求窄任务提供完整职业报告。未知不是能力不足，正确拒绝不等于所有维度低分。无适用内容或缺证据用未评，说明原因。失败和未执行轮次保留；评价已交付内容及其对整段任务完成的影响，不给未执行轮次编造答案。不得阅读架构映射或AI评分后再评分。",
};
export interface HumanTurn {
  turn: number;
  executed: boolean;
  request: string;
  resumeText: string;
  constraints: unknown;
  answer: string | null;
  status: string;
  sourceCoverage: string;
  sources: { id: string; kind: string; text: string; sha256: string }[];
}
export interface HumanCard {
  id: string;
  turns: HumanTurn[];
}
export interface HumanPacket {
  version: "human-packet-v1";
  rubric: typeof humanRubric;
  cards: HumanCard[];
  mappingCommitment: string;
  digest: string;
}
export interface HumanMapping {
  packetDigest: string;
  entries: {
    cardId: string;
    caseId: string;
    architecture: "multi-agent" | "skills";
    stratum: string;
  }[];
}
export function humanPacket(
  cards: HumanCard[],
  entries: HumanMapping["entries"],
): HumanPacket {
  if (!cards.length || new Set(cards.map((c) => c.id)).size !== cards.length)
    throw Error("Empty or duplicate cards");
  for (const c of cards) {
    if (
      !c.turns.length ||
      c.turns.some(
        (t, i) =>
          t.turn !== i + 1 ||
          (t.executed ? t.answer === null : t.answer !== null),
      )
    )
      throw Error("Invalid turn coverage");
    for (const t of c.turns)
      for (const s of t.sources)
        if (s.sha256 !== hash(s.text)) throw Error("Source hash mismatch");
  }
  const payload = {
    version: "human-packet-v1" as const,
    rubric: humanRubric,
    cards,
    mappingCommitment: hash(entries),
  };
  return { ...payload, digest: hash(payload) };
}
const Scores = z
  .object(
    Object.fromEntries(
      dimensions.map((d) => [d, z.number().int().min(0).max(4).nullable()]),
    ) as Record<(typeof dimensions)[number], z.ZodNullable<z.ZodNumber>>,
  )
  .strict();
export const HumanSubmission = z
  .object({
    version: z.literal("human-scores-v1"),
    packetDigest: z.string(),
    reviewerId: z.string().trim().min(1).max(100),
    ratings: z.array(
      z
        .object({
          cardId: z.string(),
          status: z.enum(["completed", "unassessed"]),
          scores: Scores,
          note: z.string().trim().min(1),
          issues: z.array(
            z
              .object({
                turn: z.number().int().positive(),
                severity: z.enum(["minor", "major", "critical"]),
                evidence: z.string().trim().min(1),
                reason: z.string().trim().min(1),
              })
              .strict(),
          ),
        })
        .strict(),
    ),
  })
  .strict();
export function validateHumanSubmission(packet: HumanPacket, input: unknown) {
  const { digest, ...payload } = packet;
  if (hash(payload) !== digest) throw Error("Packet changed");
  const submission = HumanSubmission.parse(input);
  if (submission.packetDigest !== digest) throw Error("Wrong packet");
  if (
    new Set(submission.ratings.map((r) => r.cardId)).size !==
    submission.ratings.length
  )
    throw Error("Duplicate ratings");
  for (const r of submission.ratings) {
    const card = packet.cards.find((c) => c.id === r.cardId);
    if (!card) throw Error("Unknown card");
    if (
      r.status === "unassessed" &&
      dimensions.some((d) => r.scores[d] !== null)
    )
      throw Error("Unassessed card has scores");
    if (r.issues.some((i) => i.turn > card.turns.length))
      throw Error("Issue outside conversation");
  }
  return submission;
}

/** One conversation is one paired unit; never treat its turns as independent samples. */
export function analyzeHuman(
  packet: HumanPacket,
  mapping: HumanMapping,
  input: unknown,
) {
  const submission = validateHumanSubmission(packet, input);
  if (
    mapping.packetDigest !== packet.digest ||
    hash(mapping.entries) !== packet.mappingCommitment ||
    mapping.entries.length !== packet.cards.length ||
    new Set(mapping.entries.map((e) => e.cardId)).size !==
      packet.cards.length ||
    mapping.entries.some((e) => !packet.cards.some((c) => c.id === e.cardId))
  )
    throw Error("Mapping mismatch");
  const pairs = new Map<string, typeof mapping.entries>();
  for (const e of mapping.entries)
    pairs.set(e.caseId, [...(pairs.get(e.caseId) ?? []), e]);
  for (const p of pairs.values())
    if (
      p.length !== 2 ||
      new Set(p.map((e) => e.architecture)).size !== 2 ||
      p[0]!.stratum !== p[1]!.stratum
    )
      throw Error("Invalid architecture pair");
  const rows = [...pairs.entries()].map(([caseId, p]) => {
    const scores = (arch: string) => {
      const r = submission.ratings.find(
        (r) => r.cardId === p.find((e) => e.architecture === arch)!.cardId,
      );
      return r?.status === "completed" ? r.scores : null;
    };
    const multi = scores("multi-agent"),
      skills = scores("skills");
    const delta = Object.fromEntries(
      dimensions.map((d) => [
        d,
        multi?.[d] != null && skills?.[d] != null
          ? multi[d]! - skills[d]!
          : null,
      ]),
    );
    return {
      caseId,
      stratum: p[0]!.stratum,
      multi,
      skills,
      delta,
      meanDelta: dimensions.every((d) => delta[d] != null)
        ? dimensions.reduce((s, d) => s + delta[d]!, 0) / 5
        : null,
    };
  });
  const mean = (x: number[]) =>
    x.length ? x.reduce((a, b) => a + b, 0) / x.length : null;
  const summary = (selected: typeof rows) =>
    Object.fromEntries(
      [...dimensions, "meanDelta"].map((d) => {
        const vals = selected
          .map((r) => (d === "meanDelta" ? r.meanDelta : r.delta[d]))
          .filter((v): v is number => v != null);
        let state = 20261017;
        const random = () => {
          state = (Math.imul(1664525, state) + 1013904223) >>> 0;
          return state / 4294967296;
        };
        const boot =
          vals.length < 2
            ? []
            : Array.from({ length: 5000 }, () =>
                mean(
                  vals.map(() => vals[Math.floor(random() * vals.length)]!),
                )!,
              ).sort((a, b) => a - b);
        return [
          d,
          {
            pairs: vals.length,
            plannedPairs: selected.length,
            multiMinusSkills: mean(vals),
            percentile95: boot.length ? [boot[124], boot[4874]] : null,
          },
        ];
      }),
    );
  return {
    reviewerType: "human",
    reviewerId: submission.reviewerId,
    packetDigest: packet.digest,
    plannedCards: packet.cards.length,
    submitted: submission.ratings.length,
    completed: submission.ratings.filter((r) => r.status === "completed")
      .length,
    unassessed: submission.ratings.filter((r) => r.status === "unassessed")
      .length,
    pending: packet.cards.length - submission.ratings.length,
    overall: summary(rows),
    strata: Object.fromEntries(
      [...new Set(rows.map((r) => r.stratum))].map((s) => [
        s,
        summary(rows.filter((r) => r.stratum === s)),
      ]),
    ),
    pairs: rows,
    criticalIssues: submission.ratings.flatMap((r) =>
      r.issues
        .filter((i) => i.severity === "critical")
        .map((i) => ({ cardId: r.cardId, ...i })),
    ),
    limitations: [
      "Single-reviewer development observations, not a population or causal conclusion.",
      "Intervals resample paired conversations (5000 draws, fixed seed); missing scores are not zero.",
      "Equal five-dimension mean only for pairs with all ten scores; per-dimension denominators can differ.",
      "Quality and operational resource metrics remain separate; no combined performance score.",
    ],
  };
}
