import { hash } from "./config.js";
import type { Message } from "./contracts.js";
import { HistoryRead } from "./input-history-tools.js";

/** Detect consecutive identical successful history-only batches in one attempt.
 * Reads remain authorized by the real tools. This is control state, not evidence.
 * Completed responses from the current/future graph turn are excluded so recovery
 * rebuilds the same decision before consulting its stored model response.
 */
export function historyReadLoop(
  calls: Record<string, unknown>[],
  executionId: string,
  role: string,
  beforeTurn: number,
  cache: (key: string) => unknown,
) {
  const prefix = `expert:${executionId}:turn:`;
  const turns = new Map<number, Record<string, unknown>>();
  for (const c of calls) {
    if (typeof c.scope !== "string" || !c.scope.startsWith(prefix)) continue;
    const suffix = c.scope.slice(prefix.length);
    if (!/^\d+$/.test(suffix)) continue;
    const turn = Number(suffix);
    if (turn < beforeTurn) turns.set(turn, c);
  }
  let consecutiveIdenticalBatches = 0,
    fingerprint: string | null = null;
  // Five is enough to establish the stop condition; no need to rehash a long run.
  for (let turn = beforeTurn - 1; turn >= Math.max(0, beforeTurn - 5); turn--) {
    const c = turns.get(turn),
      response = c?.response as Message | undefined;
    if (c?.status !== "completed" || !response?.tool_calls?.length) break;
    const pages: string[] = [];
    for (const call of response.tool_calls) {
      if (call.function.name !== "input_history_read") break;
      try {
        const args = HistoryRead.parse(JSON.parse(call.function.arguments));
        const result = cache(
          hash([executionId, role, "input_history_read", args]),
        ) as
          | {
              sourceId?: string;
              offset?: number;
              end?: number;
              textHash?: string;
              evidence?: unknown;
            }
          | undefined;
        if (!result?.evidence || result.sourceId !== args.sourceId) break;
        pages.push(hash(result));
      } catch {
        break;
      }
    }
    if (pages.length !== response.tool_calls.length) break;
    const next = hash([...new Set(pages)].sort());
    if (fingerprint !== null && next !== fingerprint) break;
    fingerprint = next;
    consecutiveIdenticalBatches++;
  }
  return {
    schemaVersion: "history-read-loop-v1",
    consecutiveIdenticalBatches,
    fingerprint,
    phase:
      consecutiveIdenticalBatches >= 5
        ? "stopped"
        : consecutiveIdenticalBatches >= 3
          ? "change_action"
          : "normal",
    instruction:
      consecutiveIdenticalBatches >= 3
        ? "连续多轮只读取相同历史原文，未推进任务。原文已返回；核对当前证据，继续问题处理、评分、协作或提交。仍可读取真正需要的新页面，必要的逐字核对仍允许；不要原样重复整批读取。若继续两轮重复且无其他动作，本次专家将以无进展结束，不自动整段重试；不得为绕过检测调用无关工具或伪造结果。"
        : "正常分页和必要的原文重读允许；此状态不授予证据权限，也不说明业务完成。",
  };
}
