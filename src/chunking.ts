export const CHUNK_POLICY = {
  version: "token-checked-spans-v1",
  maxTokens: 512,
  maxCodePoints: 2048,
  overlapCodePoints: 64,
} as const;
export interface TextSpan {
  start: number;
  end: number;
  text: string;
  tokens: number;
}
/** UTF-16 offsets refer to the original text; decoding never rewrites sources. */
export function chunkText(
  text: string,
  countTokens: (s: string) => number,
  prefix = "",
  maxTokens: number = CHUNK_POLICY.maxTokens,
): TextSpan[] {
  if (!text.length) return [];
  if (countTokens(prefix) >= maxTokens)
    throw new Error("Embedding prefix consumes the token window");
  const boundaries = [0];
  for (const ch of text) boundaries.push(boundaries.at(-1)! + ch.length);
  const count = boundaries.length - 1,
    spans: TextSpan[] = [];
  let start = 0;
  while (start < count) {
    let lo = start + 1,
      hi = Math.min(count, start + CHUNK_POLICY.maxCodePoints),
      best = start;
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (
        countTokens(prefix + text.slice(boundaries[start], boundaries[mid])) <=
        maxTokens
      ) {
        best = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (best === start)
      throw new Error("A text code point cannot fit in the embedding window");
    const chunk = text.slice(boundaries[start], boundaries[best]);
    const tokens = countTokens(prefix + chunk);
    if (tokens > maxTokens)
      throw new Error("Tokenizer window validation failed");
    spans.push({
      start: boundaries[start]!,
      end: boundaries[best]!,
      text: chunk,
      tokens,
    });
    if (best === count) break;
    start = Math.max(
      start + 1,
      best -
        Math.min(
          CHUNK_POLICY.overlapCodePoints,
          Math.floor((best - start) / 4),
        ),
    );
  }
  return spans;
}
