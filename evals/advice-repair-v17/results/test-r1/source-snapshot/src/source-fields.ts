import { hash } from "./config.js";
import { parseCalculation, type Calculation } from "./calculation.js";
import { jsonSpans } from "./json-locations.js";
import type { ReviewSource } from "./assertion-review.js";

export function reviewSourceHash(source: ReviewSource) {
  return hash([
    source.id,
    source.kind,
    source.origin ?? null,
    source.window ?? null,
    source.text,
  ]);
}

/** Index only the supplied authorized page. Never retrieve an unseen parent. */
export function structuredSource(source: ReviewSource) {
  if (
    ![
      "artifact",
      "calculation",
      "job",
      "category",
      "graph",
      "control",
    ].includes(source.kind)
  )
    return;
  try {
    const value: unknown = JSON.parse(source.text);
    if (!value || typeof value !== "object") return;
    let calculation: Calculation | undefined;
    if (source.kind === "calculation") {
      if (!source.origin) return;
      calculation = parseCalculation({
        id: source.origin.sourceId,
        sourceId: source.origin.sourceId,
        version: source.origin.version,
        kind: "calculation",
        text: source.text,
      });
    }
    return {
      sourceHash: reviewSourceHash(source),
      spans: jsonSpans(value, source.text),
      calculation,
    };
  } catch {
    return;
  }
}

/** Small navigational directory. Values are deliberately not citation evidence.
 * Deeper known pointers can still be read; oversized containers use offset reads. */
export function fieldDirectory(
  index: NonNullable<ReturnType<typeof structuredSource>>,
) {
  const all = [...index.spans].filter(([p]) => p && p.split("/").length <= 3);
  all.sort(([a], [b]) => {
    const priority = (p: string) =>
      p.startsWith(index.calculation ? "/result/" : "/artifact/") ? 0 : 1;
    return priority(a) - priority(b) || a.localeCompare(b, "en");
  });
  return {
    sourceHash: index.sourceHash,
    fields: all.slice(0, 24).map(([pointer, s]) => ({
      pointer,
      type:
        s.value === null
          ? "null"
          : Array.isArray(s.value)
            ? "array"
            : typeof s.value,
      start: s.keyStart,
      end: s.end,
    })),
    omittedFields: index.spans.size - 1 - Math.min(all.length, 24),
    scope:
      "At most 24 shallow fields (depth <= 2). Pointers and UTF-16 offsets refer only to this authorized page, not citation evidence. Deeper fields may be read by exact JSON Pointer; use offset pages for large values.",
  };
}

/** Include actual calculation identity and scope pages with the requested field,
 * so a detached number cannot masquerade as a result from another query. */
export function fieldRanges(
  source: ReviewSource,
  sourceHash: string,
  pointer: string,
) {
  if (reviewSourceHash(source) !== sourceHash)
    throw Error("Review field source hash changed");
  const index = structuredSource(source);
  if (!index)
    throw Error("Review field index unavailable: use authorized offset pages");
  const field = index.spans.get(pointer);
  if (!field) throw Error(`Review field pointer not found: ${pointer}`);
  const ranges: [number, number][] = [[field.keyStart, field.end]];
  if (index.calculation) {
    ranges.push([0, index.spans.get("/result")!.start]);
    const row = pointer.match(/^\/result\/categoryCoverage\/\d+(?=\/|$)/u)?.[0];
    for (const path of [
      "/result/appliedConstraints",
      "/result/dataScope",
      "/result/categoryPartition",
      "/result/memoryScope",
      ...(row ? [row] : []),
    ]) {
      const s = index.spans.get(path);
      if (s) ranges.push([s.keyStart, s.end]);
    }
  }
  const merged: [number, number][] = [];
  for (const [start, end] of ranges.sort((a, b) => a[0] - b[0])) {
    const last = merged.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  if (merged.reduce((n, [a, b]) => n + b - a, 0) > 6000)
    throw Error(
      `Review field bundle exceeds 6000 characters; use offset pages. Requested field start=${field.keyStart}, end=${field.end}`,
    );
  return merged;
}
