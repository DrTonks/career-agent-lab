import type { Config } from "./config.js";
import type { Message } from "./contracts.js";

/** Preserve all read pages of authorized dependency versions, not just the last page. */
export function dependencyReadGroups(
  messages: Message[],
  retainedEvidence: string[],
) {
  const groups = new Set<Message>();
  const covered = new Map<string, [number, number][]>();
  const unpaged = new Set<string>();
  for (let i = messages.length - 1; i >= 0; i--) {
    const first = messages[i]!;
    if (first.role !== "assistant" || !first.tool_calls?.length) continue;
    for (
      let j = i + 1;
      j < messages.length && messages[j]!.role === "tool";
      j++
    ) {
      try {
        const page = JSON.parse(messages[j]!.content ?? "{}"),
          e = page.evidence;
        const identity = `${e?.id}@${e?.version}`;
        if (
          e?.kind !== "artifact" ||
          !retainedEvidence.includes(identity) ||
          typeof e.text !== "string" ||
          !e.text.length
        )
          continue;
        if (
          Number.isInteger(page.offset) &&
          page.offset >= 0 &&
          Number.isInteger(page.totalChars) &&
          page.offset + e.text.length <= page.totalChars
        ) {
          const start = page.offset,
            end = start + e.text.length;
          const key = `${identity}/${page.totalChars}`;
          const ranges = covered.get(key) ?? [];
          let cursor = start;
          for (const [a, b] of ranges) {
            if (a > cursor) break;
            cursor = Math.max(cursor, b);
          }
          if (cursor >= end) continue;
          groups.add(first);
          const merged: [number, number][] = [];
          for (const range of [
            ...ranges,
            [start, end] as [number, number],
          ].sort((a, b) => a[0] - b[0])) {
            const last = merged.at(-1);
            if (last && range[0] <= last[1])
              last[1] = Math.max(last[1], range[1]);
            else merged.push([...range]);
          }
          covered.set(key, merged);
        } else {
          // Legacy/unpaged responses can only be deduplicated by exact content.
          const key = JSON.stringify([identity, e.text]);
          if (!unpaged.has(key)) {
            unpaged.add(key);
            groups.add(first);
          }
        }
      } catch {
        /* Other tool results have no dependency-page obligation. */
      }
    }
  }
  return groups;
}
/** Reservations are within existing run limits, never extra allowance. */
export function phaseCapacity(cfg: Config, scope: string) {
  const final =
    scope === "synthesize" ||
    scope.startsWith("final-review:") ||
    scope.startsWith("final-repair:");
  const reserve = cfg.finalReview === "model" && !final;
  const calls = reserve
    ? Math.min(cfg.finalReserveCalls, Math.max(0, cfg.maxCalls - 2))
    : 0;
  const input = reserve
    ? Math.min(
        cfg.finalReserveInputTokens,
        Math.floor(cfg.maxInputTokens * 0.6),
      )
    : 0;
  const output = reserve
    ? Math.min(
        cfg.finalReserveOutputTokens,
        Math.floor(cfg.maxOutputTokens * 0.6),
      )
    : 0;
  return {
    policy: "explicit-final-reservation-v2",
    requestedReservation: {
      calls: cfg.finalReserveCalls,
      input: cfg.finalReserveInputTokens,
      output: cfg.finalReserveOutputTokens,
    },
    calls: cfg.maxCalls - calls,
    input: cfg.maxInputTokens - input,
    output: cfg.maxOutputTokens - output,
    reserved: { calls, input, output },
    final,
  };
}
