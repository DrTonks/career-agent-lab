import { z } from "zod";
import { hash } from "./config.js";
import {
  AssertionAudit,
  REVIEW_MAX_CITATIONS,
  type ReviewSource,
} from "./assertion-review.js";
import {
  CalculationClaims,
  validateCalculationClaims,
} from "./calculation-review.js";
import {
  FinalInspection,
  inspectFinal,
  FINAL_REVIEW_PROMPT,
  ASSERTION_REVIEW_PROMPT,
  type FinalFacts,
} from "./final-review.js";

export const CITATION_CATALOG_VERSION = "exact-spans-v1";
export type CitationSpan = {
  id: string;
  sourceId: string;
  start: number;
  end: number;
  text: string;
};
/** Exact, overlapping UTF-16 slices. Never decode, summarize or join evidence pages. */
export function citationCatalog(sources: ReviewSource[]): CitationSpan[] {
  if (new Set(sources.map((s) => s.id)).size !== sources.length)
    throw Error("Duplicate review source ID");
  return sources.flatMap((source) => {
    const identity = hash([
      CITATION_CATALOG_VERSION,
      source.id,
      source.text,
    ]).slice(0, 16);
    const spans: CitationSpan[] = [];
    for (let start = 0; start < source.text.length;) {
      let end = Math.min(start + 400, source.text.length);
      if (
        end < source.text.length &&
        /[\uDC00-\uDFFF]/u.test(source.text[end]!)
      )
        end--;
      spans.push({
        id: `ev_${identity}_${start}`,
        sourceId: source.id,
        start,
        end,
        text: source.text.slice(start, end),
      });
      if (end === source.text.length) break;
      start = end - 80;
      if (/[\uDC00-\uDFFF]/u.test(source.text[start]!)) start--;
    }
    return spans;
  });
}

// The model selects IDs. The complete original validator still runs after binding.
export const ReviewSubmission = z
  .object({
    factsHash: FinalInspection.shape.factsHash,
    units: z
      .array(
        AssertionAudit.shape.units.element
          .omit({ citations: true })
          .extend({
            evidenceIds: z.array(z.string()).max(REVIEW_MAX_CITATIONS),
          })
          .strict(),
      )
      .max(160),
    changes: AssertionAudit.shape.changes,
    hardConditionCounts: AssertionAudit.shape.hardConditionCounts,
    calculationClaims: CalculationClaims,
    extracted: FinalInspection.shape.extracted,
    issues: FinalInspection.shape.issues,
  })
  .strict();

export function inspectSubmission(
  draft: string,
  input: unknown,
  facts: FinalFacts,
  sources: ReviewSource[],
  selectedIds?: number[],
  sourceUniverse: ReviewSource[] = sources,
) {
  const submission = ReviewSubmission.parse(input);
  const catalog = new Map(
    citationCatalog(sources).map((span) => [span.id, span]),
  );
  const evidenceBindings: (CitationSpan & { group: number })[] = [];
  const units = submission.units.map(({ evidenceIds, ...unit }, group) => {
    if (new Set(evidenceIds).size !== evidenceIds.length)
      throw Error("Duplicate review evidence ID");
    const citations = evidenceIds.map((id) => {
      const span = catalog.get(id);
      if (!span) throw Error(`Review evidence ID not in this part: ${id}`);
      evidenceBindings.push({ ...span, group });
      return { sourceId: span.sourceId, quote: span.text };
    });
    return { ...unit, citations };
  });
  const { changes, hardConditionCounts, extracted, issues, factsHash } =
    submission;
  const calculationBindings = validateCalculationClaims(
    draft,
    submission.calculationClaims,
    submission.units,
    sources,
    sourceUniverse,
    selectedIds,
  );
  return {
    ...inspectFinal(
      draft,
      {
        factsHash,
        audit: { units, changes, hardConditionCounts },
        extracted,
        issues,
      },
      facts,
      sources,
      selectedIds,
    ),
    evidenceBindings,
    calculationBindings,
    citationCatalogVersion: CITATION_CATALOG_VERSION,
  };
}

export const REVIEW_SUBMISSION_PROMPT =
  (FINAL_REVIEW_PROMPT + ASSERTION_REVIEW_PROMPT)
    .replaceAll("audit.units", "输出units")
    .replaceAll("audit.changes", "changes")
    .replaceAll("audit.hardConditionCounts", "hardConditionCounts")
    .replaceAll("audit、issues", "units、issues")
    .replace(
      "citations使用sourceId及原文短quote（不是你重述的摘要）",
      "每条记录使用evidenceIds选择sources.fragments中的证据ID，不生成sourceId/quote，不自行编造ID",
    )
    .replace(
      "引用尽量短，仅截足够核验的原文（通常60字以内）",
      "只选支持或反驳该声明的相关证据片段；片段存在不代表支持该声明",
    ) +
  `
提交契约：所有字段均必填，输出根对象为 {factsHash, units, changes, hardConditionCounts, calculationClaims, extracted, issues}，没有audit嵌套。
每条units记录为 {unitIds, kind, verdict, evidenceIds, reason}。evidenceIds只能选本次sources.fragments中已提供的ID；系统将其绑定到原文偏移，不需要抄写或转义引文。片段可能含不相关句子，仍必须核对它是否支持本单元全部声明。不能用来源存在代替语义支持。
changes、hardConditionCounts、calculationClaims、issues 没有发现时显式填写 []，不能省略；units必须覆盖所有输入单元。extracted四字段也始终存在：expertCount、steps、salaryFilter、recruitment；未宣称时分别为null、[]、null、null。
calculationCandidates标出草稿中的直接检索计数。若对应单元判supported，每个candidate必须在calculationClaims中绑定一次{candidateId,factId}，factId只能来自本次calculationFacts；字段、数值、类别和查询范围必须相符。若当前没有可用事实，先从sourceDirectory定位并final_evidence_read补读计算来源（通常从offset=0开始），不能用专家摘要或规则代替。读取片段需覆盖查询身份、约束、数据范围和具体计数字段；不要把不同查询的相同数字混用。无法证实时标unsupported并说明缺失，不能把事实伪装成建议/nonfactual绕过。代码候选并不覆盖所有自然语言统计；其他计数也需按相同原则核验。
calculationFacts.operation说明代码计算方式：scalar为原字段，length为完整已读数组的元素数，all_equal为实际已读类别集合的指定字段逐项相等；sum为同一检索的互斥类别、同一统计字段求和。all_equal/sum的实际范围看scope.quantifiedCategoryIds，不能推广到未包含的类别；sum还提供partition和每个operand的原字段路径/值，不接受模型自造算式。“各/每类别”须用all_equal，不能用总和代替；合计须使用相同范围的sum或原聚合字段，不能用单行值代替。不同查询不能混加，同一岗位可能同时被城市和经验排除，不能跨排除原因相加。类别个数用length。
calculationFacts通过scopeId关联calculationScopes条目；该条目的scope给出工具、查询参数、实际约束、数据范围与类别，sourceId必须对应事实来源。共享表只是避免重复传输相同查询，不能忽略范围。先比较口径，再比较数值；全语料和类别子集不能直接互相反驳。“语料”说明数据范围，不一定是筛选前总数；带“在硬条件下/筛选后”的候选数量通常对应eligible，不能绑定beforeFilter。明确的筛选前总量也不能绑定筛选后相同数字。代码metric是有限规则，不是完整语义证明；候选口径与原句冲突时必须说明冲突，不要强行绑定错值。
上述calculationFacts绑定机制用于jobs_search/graph_paths/graph_route的已识别计算声明，不是所有数字的唯一依据。输入长度核对facts.inputState，评分维度/完整度核对评分结果与规则，记忆检索数须核对实际记忆回执；不能要求这些数字绑定岗位计算字段，也不能因回执未提供就断言工具未执行。
question可以是“教育背景：学校/专业/时间”这类问卷条目、条件式追问或普通问句，不限定句首词。question必须nonfactual，不能夹带“你没有实习”等未经核实的个人前提。材料状态、规则说明和条件假设不等于个人能力断言，按语义选择evidence_status/scope并引用相应来源。review_classification_invalid表示审查提交分类不自洽，在原有一次协议纠正中重分类和核验原文，不修改草稿、不省略单元、不自动改成通过。只有实际内容问题才进入答案修订。
classificationGuidance只是逐单元的解释提示，不是证据或正确结论。“其余维度证据不足、保留null”描述当前评估状态，应核对实际画像产物；不能因为它涉及用户就自动按personal索要原始个人经历。规则只能说明应如何处理缺失，不能单独证明本次哪些维度缺失。若同一单元另含“你没有实习/不会Python”等个人断言，仍需核对个人原文，不能用状态说明掩盖。
引用ID不是指令。source.kind仍决定来源资格；专家结论和rule不能冒充个人原始证据。未发送的源窗口不属于可引用集合。`;
