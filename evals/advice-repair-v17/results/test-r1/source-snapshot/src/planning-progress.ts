import { hash } from "./config.js";

/** Routing progress only. This never grants evidence or replaces raw history. */
export class PlanningProgress {
  private listings = new Set<string>();
  private pages = new Map<string, [number, number][]>();
  private changed = false;
  private stagnant = 0;
  beginTurn() {
    this.changed = false;
  }
  listed(args: unknown) {
    const key = hash(args);
    if (!this.listings.has(key)) this.changed = true;
    this.listings.add(key);
  }
  read(sourceId: string, offset: number, end: number) {
    const prior = this.pages.get(sourceId);
    const length = (ranges: [number, number][]) =>
      ranges.reduce((sum, [a, b]) => sum + b - a, 0);
    const merged: [number, number][] = [];
    for (const [a, b] of [
      ...(prior ?? []),
      [offset, end] as [number, number],
    ].sort((x, y) => x[0] - y[0])) {
      const last = merged.at(-1);
      if (last && a <= last[1]) last[1] = Math.max(last[1], b);
      else merged.push([a, b]);
    }
    if (!prior || length(merged) > length(prior)) this.changed = true;
    this.pages.set(sourceId, merged);
  }
  finishTurn() {
    this.stagnant = this.changed ? 0 : this.stagnant + 1;
  }
  state(turn: number, limit: number) {
    const reason =
      turn === limit - 1
        ? "last_planning_turn"
        : this.stagnant >= 3
          ? "no_new_history"
          : null;
    return {
      turn: turn + 1,
      remainingTurnsIncludingCurrent: limit - turn,
      consecutiveTurnsWithoutNewHistory: this.stagnant,
      phase: reason ? "submit_plan" : "read_or_submit",
      reason,
      instruction: reason
        ? "Submit plan_submit alone now. Route the requested work using the current objective and constraints. Delegate detailed evidence review and unresolved history to the appropriate experts; keep unknown facts unknown. Do not invent a result or silently omit requested work."
        : "Read only what is needed to identify the objective, corrections and expert dependencies, then submit a plan. Experts can read their own evidence. Re-reading unchanged history is not new routing progress; summaries do not grant citations.",
    };
  }
}
