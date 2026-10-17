import { z } from "zod";
import type { ReviewSource } from "./assertion-review.js";
import { hash } from "./config.js";
import { selectReviewSources } from "./review-plan.js";
import {
  structuredSource,
  fieldDirectory,
  fieldRanges,
} from "./source-fields.js";

export const REVIEW_READ_LIMIT = 2;
export const ReviewEvidenceRead = z
  .object({
    requests: z
      .array(
        z.union([
          z
            .object({
              sourceId: z.string(),
              offset: z.number().int().nonnegative(),
              maxChars: z.number().int().min(1).max(6000),
            })
            .strict(),
          z
            .object({
              sourceId: z.string(),
              sourceHash: z.string().regex(/^[a-f0-9]{64}$/u),
              pointer: z.string().max(512),
            })
            .strict(),
        ]),
      )
      .min(1)
      .max(3),
  })
  .strict();

/** Directory entries locate already authorized pages. They are not citation evidence. */
export function reviewSourceDirectory(sources: ReviewSource[]) {
  return sources.map((s) => {
    const index = structuredSource(s);
    let calculation: Record<string, unknown> | undefined;
    if (index?.calculation) {
      const body = index.calculation;
      calculation = {
        tool: body.tool,
        query: String(body.arguments.query ?? "").slice(0, 200),
        categoryIds: body.arguments.categoryIds,
        fields: Object.keys(body.result),
        arguments:
          JSON.stringify(body.arguments).length <= 1200
            ? body.arguments
            : undefined,
        argumentsOmitted: JSON.stringify(body.arguments).length > 1200,
      };
    }
    return {
      sourceId: s.id,
      kind: s.kind,
      totalChars: s.text.length,
      origin: s.origin,
      calculation,
      structured: index ? fieldDirectory(index) : undefined,
      locator: calculation ? undefined : s.text.slice(0, 100),
    };
  });
}

/** No store/knowledge access: reads can only slice pages already passed to the review. */
export function readReviewEvidence(input: unknown, sources: ReviewSource[]) {
  const request = ReviewEvidenceRead.parse(input);
  const pages = request.requests.flatMap((r) => {
    const source = sources.find((s) => s.id === r.sourceId);
    if (!source) throw Error(`Review source not authorized: ${r.sourceId}`);
    const ranges =
      "pointer" in r
        ? fieldRanges(source, r.sourceHash, r.pointer)
        : [[r.offset, Math.min(r.offset + r.maxChars, source.text.length)]];
    return ranges.map(([offset, endOffset]) => {
      if (offset! >= source.text.length)
        throw Error(`Review source offset out of range: ${r.sourceId}`);
      let start = offset!,
        end = endOffset!;
      if (/[\uDC00-\uDFFF]/u.test(source.text[start]!)) start--;
      if (
        end < source.text.length &&
        /[\uDC00-\uDFFF]/u.test(source.text[end]!)
      )
        end--;
      if (end <= start)
        throw Error("Review source page contains no complete character");
      if (start === 0 && end === source.text.length) return source;
      return {
        ...source,
        id: `${source.id}@${start}:${end}`,
        text: source.text.slice(start, end),
        window: { parentId: source.id, start, end, total: source.text.length },
      };
    });
  });
  return [...new Map(pages.map((s) => [s.id, s])).values()];
}

export type ReviewReadHistory = {
  request: unknown;
  acceptedSourceIds: string[];
  error: string | null;
  selectionHash: string;
};

/** Admit whole requested pages in request order; rejection never widens capacity or grants a read. */
export function admitReviewPages(
  query: string,
  universe: ReviewSource[],
  limit: number,
  pinned: ReviewSource[],
  requested: ReviewSource[],
) {
  let accepted = pinned,
    selected = selectReviewSources(query, universe, limit, pinned);
  const rejected: { sourceId: string; reason: string }[] = [];
  for (const page of requested) {
    const candidate = [
      ...new Map([...accepted, page].map((s) => [s.id, s])).values(),
    ];
    try {
      const next = selectReviewSources(query, universe, limit, candidate);
      accepted = candidate;
      selected = next;
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !error.message.includes("cannot fit mandatory")
      )
        throw error;
      rejected.push({ sourceId: page.id, reason: error.message });
    }
  }
  return {
    pinned: accepted,
    selected,
    error: rejected.length
      ? JSON.stringify({
          code: "review_pages_not_admitted",
          rejected,
          acceptedSourceIds: accepted.map((s) => s.id),
          instruction:
            "Only accepted pages are in sources. Continue with those facts; if more evidence is needed, request smaller targeted pages. Repeating the same oversized batch does not increase capacity.",
        })
      : null,
  };
}

export function reviewReadRecord(
  planHash: string,
  sourceHash: string,
  request: unknown,
  selected: ReviewSource[],
  pinned: ReviewSource[],
  error: string | null,
) {
  return {
    planHash,
    sourceHash,
    request,
    selected,
    pinned,
    error,
    selectionHash: hash(selected),
  };
}
