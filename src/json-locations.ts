export type JsonSpan = {
  value: unknown;
  start: number;
  end: number;
  keyStart: number;
};

/** Exact UTF-16 offsets in canonical JSON. Reject duplicate keys, partial JSON
 * and alternate encodings instead of locating repeated values with indexOf. */
export function jsonSpans(value: unknown, text: string) {
  if (JSON.stringify(value) !== text) throw Error("Noncanonical JSON source");
  const result = new Map<string, JsonSpan>();
  const visit = (
    v: unknown,
    path: string,
    start: number,
    keyStart = start,
  ): number => {
    let end = start;
    if (Array.isArray(v)) {
      end++;
      v.forEach((x, i) => {
        if (i) end++;
        end = visit(x, `${path}/${i}`, end);
      });
      end++;
    } else if (v !== null && typeof v === "object") {
      end++;
      Object.entries(v).forEach(([key, x], i) => {
        if (i) end++;
        const begin = end;
        end += JSON.stringify(key).length + 1;
        end = visit(
          x,
          `${path}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`,
          end,
          begin,
        );
      });
      end++;
    } else end += JSON.stringify(v).length;
    result.set(path, { value: v, start, end, keyStart });
    return end;
  };
  visit(value, "", 0);
  return result;
}
