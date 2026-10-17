import { jsonSpans, type JsonSpan } from "./json-locations.js";
import { z } from "zod";
import { hash } from "./config.js";
import { parseCalculation, type Calculation } from "./calculation.js";
import { reviewUnits, type ReviewSource } from "./assertion-review.js";
import {
  memoryCalculationScope,
  countSubject,
  countToolMatches,
} from "./memory-calculation.js";

export const CalculationClaims = z
  .array(
    z
      .object({
        candidateId: z.string(),
        factId: z.string(),
      })
      .strict(),
  )
  .max(120);
export type CountCandidate = {
  id: string;
  unitId: number;
  start: number;
  end: number;
  text: string;
  value: number;
  metric: string;
  context: string;
};
const technical =
  "beforeFilter|eligible|uncertain|unknown|returnedCount|totalInSelectedCorpus|matchingCity|excludedByHardConditions|totalAvailable|totalMatches";
const numeric = "-?(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d+)?";

/** A corpus identifies the data scope, not necessarily the pre-filter count.
 * Carry a filter qualification across commas, but never across sentence/semicolon
 * boundaries. Explicit before/after qualifiers nearest the count take precedence.
 * This remains lexical guidance; query/category/number bindings are checked later.
 */
function qualifiedCountMetric(text: string, start: number, before: string) {
  const sentence = text
    .slice(0, start)
    .split(/[。；;.!?！？\n]/u)
    .at(-1)!;
  const qualifiers = [
    ...sentence.matchAll(
      /(?:筛选|过滤)(?:之)?前|原始(?:语料|岗位)(?:总量|总数)|语料总(?:量|数)/gu,
    ),
  ].map((m) => ({ index: m.index!, metric: "total" }));
  for (const m of sentence.matchAll(
    /(?:筛选|过滤)(?:之)?后|(?:满足|符合)[^，,。；;]{0,60}(?:全部硬条件|全部条件|硬约束|硬条件|约束)|在[^，,。；;]{0,60}(?:硬条件|硬约束|约束)(?:下|内)/gu,
  ))
    qualifiers.push({ index: m.index!, metric: "eligible" });
  qualifiers.sort((a, b) => a.index - b.index);
  const qualified = qualifiers.at(-1)?.metric;
  // Explicit corpus totals remain totals even in a paragraph discussing filters.
  if (
    /(?:语料|岗位)(?:总共|总计|总数(?:为)?|总量(?:为)?)[^，。；]*$/u.test(
      before,
    )
  )
    return "total";
  if (qualified) return qualified;
  return /(?:共|总)[^，。；]*$/u.test(before) ? "total" : "count";
}

/** Conservative lexical coverage of direct retrieval counts, not a general semantic classifier. */
export function countCandidates(
  units: { id: number; text: string }[],
): CountCandidate[] {
  return units.flatMap((unit) => {
    const found: CountCandidate[] = [];
    const add = (start: number, end: number, value: number, metric: string) => {
      if (found.some((c) => start < c.end && end > c.start)) return;
      found.push({
        id: `count_${unit.id}_${start}_${end}`,
        unitId: unit.id,
        start,
        end,
        text: unit.text.slice(start, end),
        value,
        metric,
        context: unit.text,
      });
    };
    for (const m of unit.text.matchAll(
      new RegExp(`\\b(${technical})\\s*[:=：]\\s*(${numeric})([%％]?)`, "gi"),
    ))
      add(
        m.index!,
        m.index! + m[0].length,
        Number(m[2]!.replaceAll(",", "")),
        (m[3] ? "ratio:" : "") + m[1]!.toLowerCase(),
      );
    if (
      /(记忆|memory|语料|候选|检索|筛选|过滤|合格|排除|岗位实例|岗位(?:共|总))/iu.test(
        unit.text,
      )
    ) {
      for (const m of unit.text.matchAll(
        new RegExp(`(${numeric})\\s*(?:条|个)`, "gu"),
      )) {
        // Do not split temporal classifiers (e.g. 18个月) merely because a
        // table row also mentions job retrieval. Actual counts in that same
        // row must still bind to a calculation receipt.
        const suffix = unit.text.slice(m.index! + m[0].length);
        if (
          m[0].endsWith("个") &&
          /^\s*(?:月|星期|小时|季度|学期|工作日|自然日)/u.test(suffix)
        )
          continue;
        const before = unit.text
          .slice(Math.max(0, m.index! - 16), m.index!)
          .split(/[，。；、]/u)
          .at(-1)!;
        const following = unit.text
          .slice(m.index! + m[0].length, m.index! + m[0].length + 16)
          .split(/[，。；、]/u)[0]!;
        // A later quantity owns its following qualifier. E.g. in "4条中3条因
        // 城市排除", city exclusion must not be attached to the preceding four.
        const nextQuantity = following.search(
          new RegExp(`${numeric}\\s*(?:条|个)`, "u"),
        );
        const after =
          nextQuantity < 0 ? following : following.slice(0, nextQuantity);
        const exclusion = (before + after).match(
          /(?:因|被)\s*(城市|薪资|学历|经验|双休|city|salary|education|experience|weekendsOff)[^，。；]{0,8}排除/u,
        );
        const field = exclusion
          ? (
              {
                城市: "city",
                薪资: "salary",
                学历: "education",
                经验: "experience",
                双休: "weekendsOff",
                city: "city",
                salary: "salary",
                education: "education",
                experience: "experience",
                weekendsOff: "weekendsOff",
              } as Record<string, string>
            )[exclusion[1]!]
          : undefined;
        let metric = /^\s*(?:类别|种类别)/u.test(after)
          ? "categorycount"
          : field
            ? `exclusion:${field}`
            : /排除[^，。；]*$/u.test(before) ||
                /^[^，。；]{0,8}排除/u.test(after)
              ? "excludedbyhardconditions"
              : /(?:未知|待核验|待核实)[^，。；]*$/u.test(before) ||
                  /^\s*(?:未知|待核实|待核验|uncertain)/u.test(after)
                ? "uncertain"
                : /合格[^，。；]*$/u.test(before) ||
                    /^\s*(?:合格|eligible)/u.test(after)
                  ? "eligible"
                  : /匹配[^，。；]*$/u.test(before) ||
                      (unit.text.includes("城市") && /^\s*命中/u.test(after))
                    ? "matchingcity"
                    : qualifiedCountMetric(unit.text, m.index!, before);
        if (
          countSubject(unit.text, m.index!, m.index! + m[0].length) === "memory"
        ) {
          const nearby = before + after;
          metric = /可用|可见|总量|总数/u.test(nearby)
            ? "totalavailable"
            : /本页|返回/u.test(nearby)
              ? "returnedcount"
              : /命中|匹配|检索/u.test(nearby)
                ? "totalmatches"
                : metric === "total"
                  ? "totalavailable"
                  : "count";
        }
        const quantified = unit.text
          .slice(0, m.index!)
          .split(/[。；;]/u)
          .at(-1)!
          .match(/每(?:个)?类别|各\s*$/u);
        if (quantified && metric !== "categorycount") metric = `all:${metric}`;
        add(
          m.index!,
          m.index! + m[0].length,
          Number(m[1]!.replaceAll(",", "")),
          metric,
        );
      }
    }
    return found.sort((a, b) => a.start - b.start);
  });
}

function categoryContext(candidate: CountCandidate) {
  const start =
    Math.max(
      ...["；", ";", "。"].map((c) =>
        candidate.context.lastIndexOf(c, candidate.start - 1),
      ),
    ) + 1;
  const stops = ["；", ";", "。"]
    .map((c) => candidate.context.indexOf(c, candidate.end))
    .filter((n) => n >= 0);
  return candidate.context.slice(
    start,
    stops.length ? Math.min(...stops) : undefined,
  );
}
function categoryMentions(candidate: CountCandidate, known: string[]) {
  const text = categoryContext(candidate);
  const tokens =
    text.match(/[a-zA-Z][a-zA-Z0-9_-]*(?:\/[a-zA-Z][a-zA-Z0-9_-]*)*/gu) ?? [];
  const expanded = tokens.flatMap((t) => {
    const [first, ...rest] = t.split("/");
    const prefix = first!.slice(0, first!.lastIndexOf("-") + 1);
    return [
      first!,
      ...rest.map((part) => (known.includes(part) ? part : prefix + part)),
    ];
  });
  const families = new Set(
    known.map((id) => id.slice(0, id.lastIndexOf("-") + 1)).filter(Boolean),
  );
  const unresolved = expanded.filter(
    (id) =>
      !known.includes(id) && families.has(id.slice(0, id.lastIndexOf("-") + 1)),
  );
  return [
    ...known.filter((id) => expanded.includes(id)),
    ...new Set(unresolved),
  ];
}

/** Explicit graph query coordinates are directed, unlike a jobs category set.
 * This checks literal query bindings, not arbitrary natural-language entailment.
 */
function graphCoordinatesMatch(
  candidate: CountCandidate,
  args: Record<string, unknown>,
  mentioned: string[],
) {
  const text = categoryContext(candidate)
    .replaceAll("**", "")
    .replaceAll("`", "");
  const id = "([a-zA-Z][a-zA-Z0-9_-]*)";
  const matches = (pattern: string, expected: unknown) =>
    [...text.matchAll(new RegExp(pattern, "gu"))]
      .filter((m) => mentioned.includes(m[1]!))
      .every((m) => m[1] === expected);
  if (
    !matches(`(?:起点|start)\\s*[:：=]?\\s*${id}`, args.start) ||
    !matches(`${id}\\s*(?:作为)?起点`, args.start) ||
    !matches(`(?:目标|终点|target)\\s*[:：=]?\\s*${id}`, args.target) ||
    !matches(`${id}\\s*(?:作为)?(?:目标|终点)`, args.target)
  )
    return false;
  for (const m of text.matchAll(
    new RegExp(`${id}\\s*(?:→|->|到|至)\\s*${id}`, "gu"),
  ))
    if (
      (mentioned.includes(m[1]!) || mentioned.includes(m[2]!)) &&
      (m[1] !== args.start || m[2] !== args.target)
    )
      return false;
  for (const m of text.matchAll(
    /(?:maxDepth\s*[:：=]?\s*|深度\s*[:：=]?\s*)(\d+)/gu,
  ))
    if (Number(m[1]) !== args.maxDepth) return false;
  return true;
}

function calculation(source: ReviewSource): Calculation | undefined {
  if (source.kind !== "calculation" || !source.origin) return;
  try {
    return parseCalculation({
      id: source.origin.sourceId,
      sourceId: source.origin.sourceId,
      version: source.origin.version,
      kind: "calculation",
      text: source.text,
    });
  } catch {
    return;
  }
}
function covered(
  source: ReviewSource,
  selected: ReviewSource[],
  start: number,
  end: number,
) {
  const ranges = selected
    .flatMap((s) => {
      if (
        s.kind !== "calculation" ||
        s.origin?.sourceId !== source.origin?.sourceId ||
        s.origin?.version !== source.origin?.version
      )
        return [];
      if (s.id === source.id && s.text === source.text)
        return [[0, source.text.length]];
      const w = s.window;
      return w?.parentId === source.id &&
        s.text === source.text.slice(w.start, w.end)
        ? [[w.start, w.end]]
        : [];
    })
    .sort((a, b) => a[0]! - b[0]!);
  let position = start;
  for (const [a, b] of ranges) {
    if (a! > position) break;
    if (b! > position) position = b!;
    if (position >= end) return true;
  }
  return false;
}
function metricMatches(metric: string, pointer: string) {
  if (metric.startsWith("all:")) {
    if (!pointer.includes("/*/")) return false;
    metric = metric.slice(4);
  } else if (pointer.includes("/*/")) return false;
  const field = pointer.split("/").at(-1)!.toLowerCase();
  if (metric === "count") return true;
  if (metric === "categorycount") return pointer === "/result/categoryCoverage";
  if (metric === "total")
    return ["beforefilter", "totalinselectedcorpus"].includes(field);
  if (metric === "uncertain" || metric === "unknown")
    return ["uncertain", "unknown"].includes(field);
  if (metric.startsWith("exclusion:"))
    return pointer.endsWith(`/exclusionCounts/${metric.slice(10)}`);
  return field === metric;
}
export function calculationFacts(
  selected: ReviewSource[],
  universe: ReviewSource[],
  candidates: CountCandidate[],
) {
  const facts: {
    id: string;
    sourceId: string;
    pointer: string;
    value: number;
    operation: "scalar" | "length" | "all_equal" | "sum";
    fieldRange: { start: number; end: number };
    scope: Record<string, unknown>;
  }[] = [];
  for (const source of universe) {
    const body = calculation(source);
    if (!body) continue;
    const memoryScope = memoryCalculationScope(body);
    if (body.tool === "memory_recall" && !memoryScope) continue;
    let spans: Map<string, JsonSpan>;
    try {
      spans = jsonSpans(body, source.text);
    } catch {
      continue;
    }
    const result = spans.get("/result")!;
    if (!covered(source, selected, 0, result.start)) continue; // Includes all query/snapshot identity.
    const scopePaths = [
      "/result/appliedConstraints",
      "/result/dataScope",
      "/result/categoryPartition",
      "/result/memoryScope",
    ].filter((p) => spans.has(p));
    if (
      !scopePaths.every((p) => {
        const s = spans.get(p)!;
        return covered(source, selected, s.keyStart, s.end);
      })
    )
      continue;
    for (const [pointer, span] of spans) {
      const operation =
        pointer === "/result/categoryCoverage" && Array.isArray(span.value)
          ? "length"
          : "scalar";
      const value =
        operation === "length" ? (span.value as unknown[]).length : span.value;
      if (typeof value !== "number" || !Number.isInteger(value) || value < 0)
        continue;
      if (
        operation !== "length" &&
        !(memoryScope
          ? /^\/result\/counts\/(?:totalAvailable|totalMatches|returnedCount)$/u.test(
              pointer,
            )
          : /^\/result\/(?:counts\/(?:beforeFilter|eligible|unknown)|returnedCount|categoryCoverage\/\d+\/(?:totalInSelectedCorpus|matchingCity|eligible|uncertain|excludedByHardConditions|exclusionCounts\/(?:city|salary|education|experience|weekendsOff)))$/u.test(
              pointer,
            ))
      )
        continue;
      const rowPath = pointer.match(/^\/result\/categoryCoverage\/\d+/u)?.[0];
      const row = rowPath ? spans.get(rowPath)! : span;
      if (!covered(source, selected, row.keyStart, row.end)) continue;
      const categoryId = rowPath
        ? (row.value as Record<string, unknown>).categoryId
        : undefined;
      if (
        !candidates.some(
          (c) =>
            metricMatches(c.metric, pointer) &&
            countToolMatches(c, body.tool, memoryScope),
        )
      )
        continue;
      facts.push({
        id: `cf_${hash([source.origin!.sourceId, source.origin!.version, operation, pointer, value]).slice(0, 24)}`,
        sourceId: source.id,
        pointer,
        value,
        operation,
        fieldRange: { start: span.keyStart, end: span.end },
        scope: {
          runId: body.runId,
          executionId: body.executionId,
          tool: body.tool,
          arguments: body.arguments,
          appliedConstraints: body.result.appliedConstraints,
          dataScope: body.result.dataScope,
          categoryId,
          memoryScope,
        },
      });
    }
    if (memoryScope) continue;
    const coverage = spans.get("/result/categoryCoverage");
    if (
      coverage &&
      Array.isArray(coverage.value) &&
      coverage.value.length &&
      covered(source, selected, coverage.keyStart, coverage.end)
    ) {
      const rows = coverage.value as Record<string, any>[];
      if (
        !rows.every(
          (r) =>
            r &&
            typeof r === "object" &&
            !Array.isArray(r) &&
            (r.categoryId === null ||
              (typeof r.categoryId === "string" && r.categoryId.length > 0)),
        )
      )
        continue;
      const known = rows.flatMap((r) =>
        typeof r.categoryId === "string" ? [r.categoryId] : [],
      );
      const unique =
        new Set(rows.map((r) => r.categoryId)).size === rows.length;
      const partition = body.result.categoryPartition as
        Record<string, unknown> | undefined;
      const partitionValid =
        body.tool === "jobs_search" &&
        unique &&
        partition?.scheme === "single-category-per-record-v1" &&
        Number.isSafeInteger(partition.recordCount) &&
        partition.recordCount ===
          (body.result.counts as Record<string, unknown> | undefined)
            ?.beforeFilter &&
        rows.every(
          (r) =>
            Number.isSafeInteger(r.totalInSelectedCorpus) &&
            r.totalInSelectedCorpus >= 0,
        ) &&
        rows.reduce((n, r) => n + r.totalInSelectedCorpus, 0) ===
          partition.recordCount;
      const added = new Set<string>();
      for (const candidate of candidates) {
        const mentioned = categoryMentions(candidate, known);
        const quantified = candidate.metric.startsWith("all:");
        if (!mentioned.every((id) => known.includes(id))) continue;
        if (
          !unique ||
          (!quantified && (!partitionValid || mentioned.length < 2))
        )
          continue;
        const chosen = mentioned.length
          ? rows.filter((r) => mentioned.includes(r.categoryId))
          : rows;
        if (!chosen.length) continue;
        for (const field of [
          "totalInSelectedCorpus",
          "matchingCity",
          "eligible",
          "uncertain",
          "excludedByHardConditions",
          ...["city", "salary", "education", "experience", "weekendsOff"].map(
            (f) => `exclusionCounts/${f}`,
          ),
        ]) {
          const values = chosen.map((row) =>
            field
              .split("/")
              .reduce(
                (v, k) => (v && typeof v === "object" ? v[k] : undefined),
                row,
              ),
          );
          const operation = quantified ? "all_equal" : "sum";
          const pointer = `/result/categoryCoverage/${quantified ? "*" : "+"}/${field}`;
          if (
            !values.every(
              (v, i) =>
                typeof v === "number" &&
                Number.isSafeInteger(v) &&
                v >= 0 &&
                v <= chosen[i]!.totalInSelectedCorpus,
            ) ||
            (quantified && !values.every((v) => v === values[0])) ||
            !metricMatches(candidate.metric, pointer)
          )
            continue;
          const numbers = values as number[];
          const value = quantified
            ? numbers[0]!
            : numbers.reduce((n, v) => n + v, 0);
          if (!Number.isSafeInteger(value)) continue;
          const categoryIds = chosen.map((r) => r.categoryId);
          const id = `cf_${hash([source.origin!.sourceId, source.origin!.version, operation, pointer, value, categoryIds]).slice(0, 24)}`;
          if (added.has(id)) continue;
          added.add(id);
          facts.push({
            id,
            sourceId: source.id,
            pointer,
            value,
            operation,
            fieldRange: { start: coverage.keyStart, end: coverage.end },
            scope: {
              runId: body.runId,
              executionId: body.executionId,
              tool: body.tool,
              arguments: body.arguments,
              appliedConstraints: body.result.appliedConstraints,
              dataScope: body.result.dataScope,
              quantifiedCategoryIds: categoryIds,
              ...(operation === "sum"
                ? {
                    categoryPartition: partition,
                    operands: chosen.map((r, i) => ({
                      categoryId: r.categoryId,
                      pointer: `/result/categoryCoverage/${rows.indexOf(r)}/${field}`,
                      value: values[i],
                    })),
                  }
                : {}),
            },
          });
        }
      }
    }
  }
  return facts;
}

export function validateCalculationClaims(
  draft: string,
  claims: z.infer<typeof CalculationClaims>,
  judgments: { unitIds: number[]; verdict: string }[],
  selected: ReviewSource[],
  universe: ReviewSource[],
  selectedIds?: number[],
) {
  const units = reviewUnits(draft).filter(
    (u) => !selectedIds || selectedIds.includes(u.id),
  );
  const candidates = countCandidates(units),
    facts = calculationFacts(selected, universe, candidates);
  const bindings: {
    candidate: CountCandidate;
    fact: ReturnType<typeof calculationFacts>[number];
  }[] = [];
  const seen = new Set<string>();
  for (const claim of claims) {
    const candidate = candidates.find((c) => c.id === claim.candidateId),
      fact = facts.find((f) => f.id === claim.factId);
    if (!candidate || !fact || seen.has(claim.candidateId))
      throw Error(
        "Invalid, unread, foreign or duplicate calculation claim binding",
      );
    seen.add(claim.candidateId);
    if (
      fact.value !== candidate.value ||
      !countToolMatches(
        candidate,
        String(fact.scope.tool),
        fact.scope.memoryScope,
      ) ||
      !metricMatches(candidate.metric, fact.pointer)
    )
      throw Error(`Calculation field/value mismatch for ${candidate.id}`);
    const knownCategories = new Set(
      universe.flatMap((s) => {
        const b = calculation(s);
        if (!b) return [];
        const categories = Array.isArray(b.result.categoryCoverage)
          ? b.result.categoryCoverage.flatMap((r) =>
              r && typeof r.categoryId === "string" ? [r.categoryId] : [],
            )
          : [];
        if (b.tool === "graph_paths")
          categories.push(
            ...[b.arguments.start, b.arguments.target].filter(
              (id): id is string => typeof id === "string",
            ),
          );
        return categories;
      }),
    );
    const mentioned = categoryMentions(candidate, [...knownCategories]);
    const args = fact.scope.arguments as Record<string, unknown>;
    const scopeCategories =
      fact.scope.tool === "graph_paths"
        ? [
            ...new Set(
              [args.start, args.target].filter(
                (id): id is string => typeof id === "string",
              ),
            ),
          ]
        : Array.isArray(fact.scope.quantifiedCategoryIds)
          ? fact.scope.quantifiedCategoryIds
          : fact.scope.categoryId
            ? [fact.scope.categoryId]
            : args.categoryIds;
    if (
      mentioned.length &&
      !(
        Array.isArray(scopeCategories) &&
        scopeCategories.length === mentioned.length &&
        scopeCategories.every((id) => mentioned.includes(String(id)))
      )
    )
      throw Error(`Calculation category scope mismatch for ${candidate.id}`);
    if (
      fact.scope.tool === "graph_paths" &&
      !graphCoordinatesMatch(candidate, args, mentioned)
    )
      throw Error(`Calculation graph query scope mismatch for ${candidate.id}`);
    bindings.push({ candidate, fact });
  }
  const missing = candidates.filter(
    (c) =>
      judgments.some(
        (j) => j.unitIds.includes(c.unitId) && j.verdict === "supported",
      ) && !seen.has(c.id),
  );
  if (missing.length)
    throw Error(
      JSON.stringify({
        error: "calculation_evidence_required",
        candidates: missing,
        instruction:
          "Supported retrieval counts require calculationClaims bound to actual calculationFacts. Read authorized receipt pages with final_evidence_read if needed, then resubmit the complete review; expert summaries are not calculation evidence. If evidence remains unavailable, report unsupported rather than inventing a binding.",
      }),
    );
  return bindings;
}
