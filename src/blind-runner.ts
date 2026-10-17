import { randomUUID } from "node:crypto";
import { Store } from "./storage.js";
import {
  estimateTokens,
  hash,
  implementationHash,
  type Config,
} from "./config.js";
import type { ModelProvider, ModelReply } from "./contracts.js";
import { ProviderError } from "./providers.js";
import { providerRequest } from "./provider-request.js";
import { StreamState } from "./stream.js";
import {
  rubric,
  reviewRequest,
  reviewSchedule,
  validateBundle,
  validateJudgment,
  type BlindBundle,
} from "./blind-review.js";

type Attempt = {
  jobId: string;
  attempt: number;
  status:
    | "started"
    | "received"
    | "valid"
    | "invalid"
    | "failed"
    | "interrupted"
    | "unassessed";
  startedAt: string;
  durationMs?: number;
  reason?: string;
  request: ReturnType<typeof reviewRequest>;
  wireRequestPlan: unknown;
  inputEstimate: number;
  outputReserved: number;
  reply?: ModelReply;
  judgment?: ReturnType<typeof validateJudgment>;
};
export class BlindRunner {
  readonly store: Store;
  constructor(path: string) {
    this.store = new Store(path);
    this.store.db
      .exec(`CREATE TABLE IF NOT EXISTS judge_meta(id TEXT PRIMARY KEY,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS judge_attempts(job_id TEXT NOT NULL,attempt INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(job_id,attempt));
      CREATE TABLE IF NOT EXISTS judge_frames(job_id TEXT NOT NULL,attempt INTEGER NOT NULL,sequence INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(job_id,attempt,sequence));`);
  }
  close() {
    this.store.close();
  }
  attempts(): Attempt[] {
    return this.store.db
      .prepare("select body from judge_attempts order by rowid")
      .all()
      .map((x) => JSON.parse(String(x.body)));
  }
  private save(a: Attempt) {
    this.store.transaction(() => {
      this.store.assertLease("judge");
      this.store.db
        .prepare(
          "insert into judge_attempts values(?,?,?) on conflict(job_id,attempt) do update set body=excluded.body",
        )
        .run(a.jobId, a.attempt, JSON.stringify(a));
    });
  }
  async execute(
    input: BlindBundle,
    provider: ModelProvider,
    cfg: Config,
    options: {
      retryFailed?: boolean;
      signal?: AbortSignal;
      afterReply?: (a: Attempt) => void;
    } = {},
  ) {
    const bundle = validateBundle(input),
      jobs = reviewSchedule(bundle),
      owner = randomUUID();
    const identity = {
      bundleHash: hash(bundle),
      rubricHash: hash(rubric),
      implementationHash: implementationHash(),
      provider: { model: provider.model, mode: provider.mode },
      config: cfg,
      jobsHash: hash(jobs),
    };
    this.store.lease("judge", owner, cfg.leaseTtlMs);
    const stop = new AbortController(),
      started = performance.now();
    const signal = AbortSignal.any([
      stop.signal,
      ...(options.signal ? [options.signal] : []),
    ]);
    const heartbeat = setInterval(
      () => {
        try {
          this.store.renewLease("judge", owner, cfg.leaseTtlMs);
        } catch {
          stop.abort(new Error("Judge execution lease lost"));
        }
      },
      Math.max(50, Math.floor(cfg.leaseTtlMs / 3)),
    );
    try {
      this.store.transaction(() => {
        this.store.assertLease("judge");
        const old = this.store.db
          .prepare("select body from judge_meta where id='identity'")
          .get();
        if (old && String(old.body) !== JSON.stringify(identity))
          throw Error(
            "Judge resume identity mismatch; use a new output directory",
          );
        if (!old) {
          this.store.db
            .prepare("insert into judge_meta values('identity',?)")
            .run(JSON.stringify(identity));
          this.store.db
            .prepare("insert into judge_meta values('bundle',?)")
            .run(JSON.stringify(bundle));
        }
      });
      for (const job of jobs) {
        signal.throwIfAborted();
        const c = bundle.cases.find((c) => c.id === job.caseId)!;
        let previous = this.attempts()
          .filter((a) => a.jobId === job.id)
          .at(-1);
        if (previous?.status === "started") {
          const stream = new StreamState();
          try {
            for (const row of this.store.db
              .prepare(
                "select body from judge_frames where job_id=? and attempt=? order by sequence",
              )
              .all(job.id, previous.attempt))
              stream.apply(JSON.parse(String(row.body)));
          } catch {
            stream.done = false;
          }
          previous = stream.done
            ? {
                ...previous,
                status: "received",
                reply: stream.snapshot(),
                reason: "Recovered complete semantic stream",
              }
            : {
                ...previous,
                status: "interrupted",
                reason:
                  "Previous process ended without a recorded complete response; remote outcome unknown",
              };
          this.save(previous);
        }
        if (previous?.status === "received") {
          try {
            previous.judgment = validateJudgment(c, job, previous.reply!);
            previous.status = "valid";
          } catch (e) {
            previous.status = "invalid";
            previous.reason = (e as Error).message;
          }
          this.save(previous);
        }
        if (previous?.status === "valid" || previous?.status === "unassessed")
          continue;
        if (previous && (!options.retryFailed || previous.attempt >= 2))
          continue;
        // No other judge's score, original agent conversation or mapping enters this request.
        const request = reviewRequest(c, job),
          inputEstimate = estimateTokens(JSON.stringify(request)),
          all = this.attempts();
        const called = all.filter((a) => a.status !== "unassessed");
        const usedInput = called.reduce(
            (s, a) => s + (a.reply?.usage.input ?? a.inputEstimate),
            0,
          ),
          usedOutput = called.reduce(
            (s, a) => s + (a.reply?.usage.output ?? a.outputReserved),
            0,
          );
        const a: Attempt = {
          jobId: job.id,
          attempt: (previous?.attempt ?? 0) + 1,
          status: "started",
          startedAt: new Date().toISOString(),
          request,
          wireRequestPlan: providerRequest(
            cfg,
            request.messages,
            request.tools,
          ),
          inputEstimate,
          outputReserved: cfg.maxResponseTokens,
        };
        const reason =
          inputEstimate + cfg.maxResponseTokens > cfg.maxContextTokens
            ? "Complete sources and answer exceed context; no truncation performed"
            : called.length >= cfg.maxCalls ||
                usedInput + inputEstimate > cfg.maxInputTokens ||
                usedOutput + cfg.maxResponseTokens > cfg.maxOutputTokens
              ? "Cumulative review capacity exhausted"
              : performance.now() - started > cfg.maxRunMs
                ? "Review invocation time exhausted"
                : undefined;
        if (reason) {
          a.status = "unassessed";
          a.reason = reason;
          this.save(a);
          continue;
        }
        this.save(a);
        const callStarted = performance.now();
        try {
          a.reply = await provider.complete(
            request.messages,
            request.tools,
            AbortSignal.any([
              signal,
              AbortSignal.timeout(cfg.requestTimeoutMs),
            ]),
            undefined,
            (frame) => {
              this.store.transaction(() => {
                this.store.assertLease("judge");
                this.store.db
                  .prepare("insert into judge_frames values(?,?,?,?)")
                  .run(
                    job.id,
                    a.attempt,
                    frame.sequence,
                    JSON.stringify(frame),
                  );
              });
            },
          );
          signal.throwIfAborted();
          a.durationMs = performance.now() - callStarted;
          a.status = "received";
          this.save(a);
        } catch (e) {
          a.durationMs = performance.now() - callStarted;
          a.status = "failed";
          // Do not record arbitrary exception text from private operator hooks.
          a.reason =
            e instanceof ProviderError
              ? e.message
              : signal.aborted
                ? "Review cancelled"
                : "Provider or local operator call failed";
          if (e instanceof ProviderError && e.partial) a.reply = e.partial;
          if (e instanceof ProviderError && e.usage && !a.reply)
            a.reply = {
              message: { role: "assistant", content: null },
              finishReason: "error",
              usage: e.usage,
            };
          this.save(a);
          if (signal.aborted || !(e instanceof ProviderError))
            throw new Error(a.reason);
          continue;
        }
        options.afterReply?.(a);
        try {
          a.judgment = validateJudgment(c, job, a.reply!);
          a.status = "valid";
        } catch (e) {
          a.status = "invalid";
          a.reason = (e as Error).message;
        }
        this.save(a);
      }
      return this.summary(bundle);
    } finally {
      clearInterval(heartbeat);
      this.store.release("judge", owner);
    }
  }
  summary(bundle: BlindBundle) {
    const attempts = this.attempts(),
      jobs = reviewSchedule(bundle);
    const rows = jobs.map((job) => ({
      job,
      ...{ result: attempts.filter((a) => a.jobId === job.id).at(-1) ?? null },
    }));
    const disagreements = bundle.cases.map((c) => {
      const ratings = rows.filter(
        (r) =>
          r.job.caseId === c.id &&
          r.job.kind === "rating" &&
          r.result?.status === "valid",
      );
      const comparisons = rows.filter(
        (r) =>
          r.job.caseId === c.id &&
          r.job.kind === "comparison" &&
          r.result?.status === "valid",
      );
      const scoreConflicts: string[] = [];
      for (const label of ["A", "B"]) {
        const rs = ratings
          .filter((r) => r.job.labels[0] === label)
          .map((r) => r.result!.judgment!);
        if (
          rs.length === 2 &&
          "dimensions" in rs[0]! &&
          "dimensions" in rs[1]!
        ) {
          const a = rs[0],
            b = rs[1];
          for (const d of a.dimensions) {
            const other = b.dimensions.find(
              (x) => x.dimension === d.dimension,
            )!;
            if (
              d.score === null || other.score === null
                ? d.score !== other.score
                : Math.abs(d.score - other.score) >= 2
            )
              scoreConflicts.push(`${label}:${d.dimension}`);
          }
          if (
            a.findings.some((f) => f.severity === "critical") !==
            b.findings.some((f) => f.severity === "critical")
          )
            scoreConflicts.push(`${label}:critical-finding`);
        }
      }
      const preferences = comparisons
        .map((r) => r.result!.judgment!)
        .filter((j) => "preference" in j)
        .map((j) => j.preference);
      return {
        caseId: c.id,
        validRatings: ratings.length,
        validComparisons: comparisons.length,
        scoreConflicts,
        preferences,
        positionSensitive:
          preferences.length === 2 && preferences[0] !== preferences[1],
        arbitrationStatus:
          ratings.length < 4 || comparisons.length < 2
            ? "awaiting-valid-reviews"
            : scoreConflicts.length ||
                (preferences.length === 2 && preferences[0] !== preferences[1])
              ? "pending"
              : "not-triggered",
        humanReview: "not-performed",
      };
    });
    return {
      reviewerType: "ai",
      modelValidation:
        "Exact quotes and schema only; semantic entailment is not guaranteed",
      planned: jobs.length,
      valid: rows.filter((r) => r.result?.status === "valid").length,
      rows,
      disagreements,
    };
  }
}
