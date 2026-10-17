import { z } from "zod";
import { hash } from "./config.js";
import { continuationContext } from "./follow-up.js";
import { supportsQuote } from "./evidence.js";
import type { Evidence, ExpertResult, Role, RunRecord } from "./contracts.js";
import type { Store } from "./storage.js";

const Citation = z
  .object({ evidenceId: z.string().min(1), quote: z.string().min(1).max(3000) })
  .strict();
const Claim = z
  .object({
    subject: z.enum(["user", "domain", "state"]),
    text: z.string().trim().min(1).max(1000),
    citations: z.array(Citation).min(1).max(6),
  })
  .strict();
const allowedSources = {
  user: ["request", "resume", "memory"],
  domain: ["job", "category", "graph", "rule", "calculation"],
  state: ["artifact", "calculation"],
} as const;

export class ClarificationFeedbackError extends Error {
  constructor(
    readonly feedback: { code: string; [key: string]: unknown },
    message = feedback.code,
  ) {
    super(message);
  }
}

export class ClarificationEvidenceError extends ClarificationFeedbackError {
  constructor(
    readonly feedback: {
      code:
        | "clarification_source_unread"
        | "clarification_source_kind"
        | "clarification_quote_mismatch";
      questionId: string;
      claimIndex: number;
      subject: z.infer<typeof Claim>["subject"];
      evidenceId: string;
      actualKind: string | null;
      allowedKinds: readonly string[];
      instruction: string;
    },
  ) {
    super(feedback, `${feedback.code}: ${feedback.evidenceId}`);
  }
}
export const ClarificationUpdate = z
  .object({
    updates: z
      .array(
        z
          .object({
            questionId: z.string().min(1),
            expectedVersion: z.number().int().nonnegative(),
            status: z.enum([
              "answered",
              "partial",
              "unanswered",
              "conflict",
              "not_applicable",
            ]),
            claims: z.array(Claim).max(12),
            remaining: z.array(z.string().min(1).max(1000)).max(12),
            reason: z.string().min(1).max(1000),
          })
          .strict(),
      )
      .max(32),
  })
  .strict();
type Update = z.infer<typeof ClarificationUpdate>["updates"][number];
export type ClarificationRecord = Omit<Update, "expectedVersion"> & {
  schemaVersion: "clarification-v2";
  version: number;
  runId: string;
  executionId: string;
  role: Role;
  questionText: string;
  snapshotHash: string;
};

export class Clarifications {
  readonly questions;
  private readonly prefix: string;
  constructor(
    private store: Store,
    private run: RunRecord,
    private executionId: string,
    private role: Role,
  ) {
    this.questions = continuationContext(run, role)?.questions ?? [];
    this.prefix = `clarification:${executionId}:${role}:`;
  }
  current(): ClarificationRecord[] {
    const latest = new Map<string, ClarificationRecord>();
    for (const { value } of this.store.cacheEntries(
      this.run.id,
      this.prefix + "state:",
    )) {
      const saved = value as {
        record: ClarificationRecord;
        recordHash: string;
      };
      const r = saved.record;
      if (!r || hash(r) !== saved.recordHash)
        throw Error("clarification_record_hash_mismatch");
      if (
        r.schemaVersion !== "clarification-v2" ||
        !z.array(Claim).safeParse(r.claims).success
      )
        throw Error("clarification_record_schema_mismatch");
      if (
        r.runId !== this.run.id ||
        r.executionId !== this.executionId ||
        r.role !== this.role ||
        r.snapshotHash !== this.run.continuation?.snapshotHash ||
        !this.questions.some((q) => q.questionId === r.questionId)
      )
        throw Error("clarification_snapshot_mismatch");
      const previous = latest.get(r.questionId);
      if (r.version !== (previous?.version ?? 0) + 1)
        throw Error("clarification_version_sequence_invalid");
      latest.set(r.questionId, r);
    }
    return [...latest.values()];
  }
  /** Receipts are written only by the named input tools, never by recursive parsing of arbitrary tool data. */
  recordInputRead(
    name: string,
    args: unknown,
    result: unknown,
    cacheKey: string,
  ) {
    if (!["input_read", "resume_read"].includes(name)) return;
    this.store.putCache(this.run.id, this.prefix + "read:" + cacheKey, {
      name,
      args,
      resultHash: hash(result),
      cacheKey,
    });
  }
  coverage() {
    const ranges: { request: number[][]; resume: number[][] } = {
      request: [],
      resume: [],
    };
    const touched = new Set<string>();
    for (const { value } of this.store.cacheEntries(
      this.run.id,
      this.prefix + "read:",
    )) {
      const receipt = value as {
        name: string;
        args: any;
        resultHash: string;
        cacheKey: string;
      };
      const result = this.store.cache(this.run.id, receipt.cacheKey) as any;
      if (
        !result ||
        hash(result) !== receipt.resultHash ||
        receipt.cacheKey !==
          hash([this.executionId, this.role, receipt.name, receipt.args])
      )
        throw Error("input_read_receipt_mismatch");
      if (receipt.name === "resume_read") {
        const expected = this.run.request.resumeText
          .split(/\n\s*\n|\r?\n/)
          .filter(Boolean);
        if (
          JSON.stringify(result.evidence?.map((e: any) => e.text)) !==
          JSON.stringify(expected)
        )
          throw Error("resume_read_receipt_mismatch");
        ranges.resume.push([0, this.run.request.resumeText.length]);
        touched.add("resume");
      } else if (receipt.name === "input_read") {
        const source = receipt.args.source as "request" | "resume";
        if (!["request", "resume"].includes(source))
          throw Error("input_read_source_invalid");
        const full =
          source === "request"
            ? this.run.request.request
            : this.run.request.resumeText;
        const start = receipt.args.offset,
          end = Math.min(full.length, start + receipt.args.maxChars);
        if (
          result.evidence?.id !== `input:${this.run.id}:${source}` ||
          result.evidence?.version !== hash(full) ||
          result.evidence?.text !== full.slice(start, end) ||
          result.offset !== start ||
          result.totalChars !== full.length
        )
          throw Error("input_read_receipt_mismatch");
        ranges[source].push([Math.min(start, full.length), end]);
        touched.add(source);
      } else throw Error("input_read_receipt_tool_invalid");
    }
    return Object.fromEntries(
      (["request", "resume"] as const).map((source) => {
        const length =
          source === "request"
            ? this.run.request.request.length
            : this.run.request.resumeText.length;
        let end = 0;
        for (const [a, b] of ranges[source].sort((x, y) => x[0]! - y[0]!)) {
          if (a! > end) break;
          end = Math.max(end, b!);
        }
        return [
          source,
          {
            complete: touched.has(source) && end === length,
            nextOffset: touched.has(source) && end === length ? null : end,
            totalChars: length,
          },
        ];
      }),
    ) as Record<
      "request" | "resume",
      { complete: boolean; nextOffset: number | null; totalChars: number }
    >;
  }
  update(input: unknown, seen: Map<string, Evidence>) {
    const args = ClarificationUpdate.parse(input);
    if (!args.updates.length)
      return {
        current: this.current(),
        questions: this.questions,
        coverage: this.coverage(),
        claimSourcePolicy: allowedSources,
      };
    return this.store.transaction(() => {
      this.store.assertCurrent(this.run);
      const command = this.prefix + "command:" + hash(args),
        old = this.store.cache(this.run.id, command);
      if (old !== undefined)
        return { applied: old, current: this.current(), replayed: true };
      const coverage = this.coverage();
      if (!coverage.request.complete || !coverage.resume.complete)
        throw new ClarificationFeedbackError({
          code: "clarification_input_incomplete",
          coverage,
          applied: [],
          instruction:
            "Read both current inputs using coverage.nextOffset. First/last pages do not cover gaps. No updates in this batch were committed.",
        });
      const current = this.current(),
        ids = new Set<string>(),
        records: ClarificationRecord[] = [];
      for (const [updateIndex, u] of args.updates.entries()) {
        const q = this.questions.find((q) => q.questionId === u.questionId);
        const prior = current.find((r) => r.questionId === u.questionId);
        const reject = (code: string, instruction: string): never => {
          throw new ClarificationFeedbackError(
            {
              code,
              updateIndex,
              questionId: u.questionId,
              questionText: q?.text ?? null,
              currentVersion: q ? (prior?.version ?? 0) : null,
              submittedStatus: u.status,
              remaining: u.remaining,
              applied: [],
              instruction:
                instruction +
                " No updates in this batch were committed; versions are unchanged. Correct the identified entry or submit a valid subset. Do not fabricate evidence or change a claim's subject to bypass checks.",
            },
            `${code}: update[${updateIndex}] ${u.questionId}`,
          );
        };
        if (!q || ids.has(u.questionId))
          reject(
            "clarification_question_invalid_or_duplicate",
            "Use only question IDs visible to this role, once per batch; query clarification_update with updates=[] for current state.",
          );
        ids.add(u.questionId);
        if (u.expectedVersion !== (prior?.version ?? 0))
          reject(
            "clarification_version_conflict",
            "Read the current record and reconcile the new statement before using currentVersion; do not blindly overwrite a correction.",
          );
        const known = ["answered", "partial", "conflict"].includes(u.status);
        if (known && !u.claims.length)
          reject(
            "clarification_answer_requires_cited_claims",
            "answered/partial/conflict require actual cited claims answering this question. If no part is answered, use unanswered with claims=[] and retain the unanswered question.",
          );
        if (!known && u.claims.length)
          reject(
            "clarification_unanswered_has_no_asserted_answer",
            "unanswered/not_applicable must have claims=[]. Put the reason in reason; related facts that do not answer this question are not a partial answer.",
          );
        if (u.claims.reduce((n, c) => n + c.text.length, 0) > 3000)
          reject(
            "clarification_answer_too_long",
            "Keep total claim text at most 3000 characters, with precise citations; split unrelated claims into their corresponding questions.",
          );
        if (
          known &&
          q!.kind === "user_input" &&
          !u.claims.some((c) => c.subject === "user")
        )
          reject(
            "clarification_user_question_requires_user_statement",
            "This question requires a user statement. Domain material or another expert's result cannot establish personal consent or preferences.",
          );
        if (
          ["partial", "unanswered", "conflict"].includes(u.status) &&
          !u.remaining.length
        )
          reject(
            "clarification_unresolved_requires_remaining_fields",
            "List the actual unresolved fields for partial/unanswered/conflict; use answered only when the whole question is supported.",
          );
        if (
          ["answered", "not_applicable"].includes(u.status) &&
          u.remaining.length
        )
          reject(
            "clarification_closed_has_no_remaining_fields",
            "answered/not_applicable must have remaining=[]. If something still needs an answer, choose the appropriate unresolved status.",
          );
        if (
          u.status === "conflict" &&
          (new Set(u.claims.map((c) => c.text)).size < 2 ||
            new Set(
              u.claims
                .flatMap((c) => c.citations)
                .map((c) => JSON.stringify(c)),
            ).size < 2)
        )
          reject(
            "clarification_conflict_requires_two_cited_statements",
            "conflict needs distinct cited statements in the same scope. An explicit user correction supersedes the old statement and is not automatically an unresolved conflict.",
          );
        for (const [claimIndex, claim] of u.claims.entries())
          for (const c of claim.citations) {
            const e = seen.get(c.evidenceId),
              allowedKinds: readonly string[] = allowedSources[claim.subject];
            const code = !e
              ? "clarification_source_unread"
              : !allowedKinds.includes(e.kind)
                ? "clarification_source_kind"
                : !supportsQuote(e, c.quote)
                  ? "clarification_quote_mismatch"
                  : undefined;
            if (code)
              throw new ClarificationEvidenceError({
                code,
                questionId: u.questionId,
                claimIndex,
                subject: claim.subject,
                evidenceId: c.evidenceId,
                actualKind: e?.kind ?? null,
                allowedKinds,
                instruction:
                  code === "clarification_source_kind"
                    ? "The source was read, but its kind cannot support this declared subject. Split mixed claims and classify their actual subject; do not relabel a personal assertion as a domain fact. Re-reading the same source will not change its kind."
                    : code === "clarification_source_unread"
                      ? "Read this source through an authorized tool before citing it. This tool does not grant access to another role, run or version."
                      : "Use an exact quote from the actually read source ranges; do not paraphrase, bridge unread gaps or invent support.",
              });
          }
        if (
          u.status === "partial" &&
          u.remaining.some((text) => text === q!.text)
        )
          reject(
            "clarification_partial_must_narrow_remaining_question",
            "The remaining question is unchanged. Use partial only when evidence actually answers a subquestion, and retain just the unresolved fields. Related experience does not answer a preference, and guided work does not by itself answer autonomous learning. If no subquestion is answered, use unanswered with claims=[]. Merely paraphrasing the original question is not progress.",
          );
        const { expectedVersion, ...data } = u;
        records.push({
          ...data,
          schemaVersion: "clarification-v2",
          version: expectedVersion + 1,
          runId: this.run.id,
          executionId: this.executionId,
          role: this.role,
          questionText: q!.text,
          snapshotHash: this.run.continuation!.snapshotHash,
        });
      }
      for (const r of records)
        this.store.putCache(
          this.run.id,
          `${this.prefix}state:${r.questionId}:${r.version}`,
          { record: r, recordHash: hash(r) },
        );
      const applied = records.map((r) => ({
        questionId: r.questionId,
        version: r.version,
      }));
      this.store.putCache(this.run.id, command, applied);
      this.store.event(
        this.run.id,
        "clarification.updated",
        { executionId: this.executionId, applied },
        this.role,
      );
      return { applied, current: this.current(), replayed: false };
    });
  }
  attach(
    result: ExpertResult,
    seen: Map<string, Evidence>,
    requireComplete: boolean,
  ) {
    if (!this.questions.length) {
      result.artifact.openQuestions = {
        schemaVersion: "open-questions-v1",
        items: [...new Set(result.unknowns)],
      };
      return;
    }
    const records = this.current(),
      pending = this.questions.filter(
        (q) => !records.some((r) => r.questionId === q.questionId),
      );
    if (requireComplete && pending.length)
      throw Error(
        `clarification_required: reconcile question IDs ${pending.map((q) => q.questionId).join(", ")} with clarification_update before finishing`,
      );
    const published = new Set(result.evidenceIds);
    for (const r of records)
      for (const c of r.claims.flatMap((claim) => claim.citations)) {
        const e = seen.get(c.evidenceId);
        if (!e || !supportsQuote(e, c.quote))
          throw Error("clarification_source_no_longer_read");
        published.add(c.evidenceId);
      }
    const replaced = new Set(records.map((r) => r.questionText));
    const unknowns = [
      ...new Set([
        ...result.unknowns.filter((text) => !replaced.has(text)),
        ...records.flatMap((r) => r.remaining),
        ...pending.map((q) => q.text),
      ]),
    ];
    result.unknowns =
      unknowns.length <= 30
        ? unknowns
        : [
            ...unknowns.slice(0, 29),
            `另有${unknowns.length - 29}项未解决信息，完整字段见artifact.clarifications及continuation问题快照。`,
          ];
    // Full machine-readable obligations survive the bounded user-facing summary.
    // Never let model-supplied artifact metadata erase unresolved fields.
    result.artifact.openQuestions = {
      schemaVersion: "open-questions-v1",
      items: unknowns,
    };
    if (published.size > 80)
      throw Error("clarification_published_sources_exceed_result_limit");
    result.evidenceIds = [...published];
    result.artifact.clarifications = records;
  }
}
