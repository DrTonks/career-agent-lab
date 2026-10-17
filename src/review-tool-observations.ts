import type { DatabaseSync } from "node:sqlite";
import { hash } from "./config.js";
import { Role, type Artifact, type RunRecord } from "./contracts.js";

const names = ["profile_score", "jobs_check"] as const;
type ToolName = (typeof names)[number];
type RecordedEvent = {
  eventId: string;
  runId: string;
  type: string;
  expert: string;
  callId: string;
  payload: {
    name?: string;
    args?: unknown;
    executionId?: string;
    cacheKey?: string;
    result?: unknown;
    replayed?: boolean;
  };
};
type Observation = {
  schema: "review-tool-observation-v1";
  tool: ToolName;
  arguments: unknown;
  result: unknown;
  scope: {
    runId: string;
    executionId: string;
    role: string;
    inputVersion: number;
    constraintVersion: number;
    datasetVersion: string;
    currentArtifactAttempt: boolean;
    currentScoreReceipt: boolean | null;
  };
  cacheKey: string;
  resultHash: string;
  provenance: {
    startedEvent: string;
    completedEvent: string;
    callId: string;
    replayed: boolean;
    identity: "event" | "model-call";
  }[];
};

/** Read accepted computation records; never execute historical code or recompute a preferred score.
 * Tool observations retain model-selected inputs and are not primary personal evidence.
 */
export function reviewToolObservations(
  db: DatabaseSync,
  run: RunRecord,
  artifacts: Artifact[],
) {
  const events = db
    .prepare("select body from events where run_id=? order by rowid")
    .all(run.id)
    .map((r) => JSON.parse(String(r.body)) as RecordedEvent);
  const calls = db
    .prepare("select body from model_calls where run_id=? order by rowid")
    .all(run.id)
    .map((r) => JSON.parse(String(r.body)));
  const cache = new Map(
    db
      .prepare(
        "select key,result from tool_cache where run_id=? order by rowid",
      )
      .all(run.id)
      .map((r) => [String(r.key), JSON.parse(String(r.result))]),
  );
  const starts = new Map<string, RecordedEvent>();
  const observations = new Map<string, Observation>();
  const coverage = Object.fromEntries(
    names.map((name) => [
      name,
      {
        started: 0,
        completed: 0,
        failed: 0,
        incomplete: 0,
        distinctResults: 0,
      },
    ]),
  );
  for (const event of events) {
    if (
      !names.includes(event.payload.name as ToolName) ||
      !["tool.started", "tool.completed", "tool.failed"].includes(event.type)
    )
      continue;
    if (event.runId !== run.id)
      throw Error("Tool event belongs to another run");
    const name = event.payload.name as ToolName,
      role = Role.parse(event.expert);
    if (
      (name === "profile_score" && role !== "profile") ||
      (name === "jobs_check" && role !== "match" && role !== "path")
    )
      throw Error("Tool observation role mismatch");
    const identity = JSON.stringify([role, event.callId, name]),
      counts = coverage[name]!;
    if (event.type === "tool.started") {
      const earlier = starts.get(identity);
      if (earlier) {
        if (
          hash(earlier.payload.args) !== hash(event.payload.args) ||
          earlier.payload.executionId !== event.payload.executionId
        )
          throw Error(
            "Tool invocation identity was reused with different arguments",
          );
        // A process may stop after start but before a completion event. Keep this
        // incomplete prefix visible even if the same invocation later recovers.
        counts.incomplete++;
      }
      starts.set(identity, event);
      counts.started++;
      continue;
    }
    const start = starts.get(identity);
    if (!start) throw Error("Tool completion/failure has no matching start");
    starts.delete(identity);
    if (event.type === "tool.failed") {
      counts.failed++;
      continue;
    }
    counts.completed++;
    let executionId = start.payload.executionId,
      identitySource: "event" | "model-call" = "event";
    if (executionId === undefined) {
      // Older events omitted execution identity. Require the exact recorded provider call,
      // not a guessed role/step name, to associate its accepted tool call with the attempt.
      const matches = calls.filter(
        (c) =>
          c.role === role &&
          c.response?.tool_calls?.some(
            (t: any) => t.id === event.callId && t.function.name === name,
          ),
      );
      if (matches.length !== 1)
        throw Error(
          "Historical tool execution identity is missing or ambiguous",
        );
      const call = matches[0],
        state = call.executionState;
      if (
        !state ||
        state.runId !== run.id ||
        state.role !== role ||
        call.executionStateHash !== hash(state) ||
        !call.scope?.startsWith(`expert:${state.executionId}:turn:`)
      )
        throw Error("Historical tool state identity mismatch");
      executionId = state.executionId;
      identitySource = "model-call";
    }
    if (typeof executionId !== "string" || !executionId)
      throw Error("Invalid tool execution identity");
    const key = hash([executionId, role, name, start.payload.args]),
      result = cache.get(key);
    if (
      (start.payload.cacheKey !== undefined &&
        start.payload.cacheKey !== key) ||
      (event.payload.cacheKey !== undefined &&
        event.payload.cacheKey !== key) ||
      (event.payload.executionId !== undefined &&
        event.payload.executionId !== executionId)
    )
      throw Error("Tool cache/attempt identity mismatch");
    if (result === undefined || hash(result) !== hash(event.payload.result))
      throw Error("Tool result/cache mismatch");
    let currentScoreReceipt: boolean | null = null;
    if (name === "profile_score") {
      const score = result as { observations: unknown };
      if (
        hash(start.payload.args) !== hash({ observations: score.observations })
      )
        throw Error("Score observations disagree with accepted arguments");
      const journals = [...cache].filter(([k]) =>
        k.startsWith(`execution:${executionId}:${role}:profile-score:`),
      );
      if (
        !journals.some(
          ([, v]) => v.cacheKey === key && v.resultHash === hash(result),
        )
      )
        throw Error("Score observation lacks a matching durable receipt");
      // An older valid receipt cannot validate the current pointer. Otherwise a
      // broken last entry silently marks every real result as historical.
      const pointer = journals.at(-1)![1],
        latest = cache.get(pointer?.cacheKey);
      if (
        !latest ||
        pointer.resultHash !== hash(latest) ||
        typeof latest.scoringVersion !== "string" ||
        !Array.isArray(latest.observations) ||
        pointer.cacheKey !==
          hash([executionId, role, name, { observations: latest.observations }])
      )
        throw Error("Current score receipt identity/result mismatch");
      currentScoreReceipt = pointer.cacheKey === key;
    }
    const observation: Observation = observations.get(key) ?? {
      schema: "review-tool-observation-v1" as const,
      tool: name,
      arguments: start.payload.args,
      result,
      scope: {
        runId: run.id,
        executionId,
        role,
        inputVersion: run.inputVersion ?? 0,
        constraintVersion: run.constraintVersion,
        datasetVersion: run.datasetVersion,
        currentScoreReceipt,
        currentArtifactAttempt: artifacts.some(
          (a) =>
            a.expert === role &&
            ((a.attempt ?? 1) === 1 ? a.stepId : `${a.stepId}@${a.attempt}`) ===
              executionId,
        ),
      },
      cacheKey: key,
      resultHash: hash(result),
      provenance: [],
    };
    observation.provenance.push({
      startedEvent: start.eventId,
      completedEvent: event.eventId,
      callId: event.callId,
      replayed: event.payload.replayed === true,
      identity: identitySource,
    });
    observations.set(key, observation);
  }
  for (const event of starts.values())
    coverage[event.payload.name as ToolName]!.incomplete++;
  for (const observation of observations.values())
    coverage[observation.tool]!.distinctResults++;
  return { observations: [...observations.values()], coverage };
}
