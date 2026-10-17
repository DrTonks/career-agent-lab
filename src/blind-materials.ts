import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { hash, readJson } from "./config.js";
import { loadDataset } from "./data.js";
import { Request, type RunRecord, type Artifact } from "./contracts.js";
import { validateBundle, type BlindBundle } from "./blind-review.js";
import { toolReferences } from "./tool-reference.js";

const Rows = z.array(
  z.object({
    caseId: z.string(),
    repeat: z.number().int().nonnegative(),
    runId: z.string(),
    architecture: z.enum(["multi-agent", "skills"]),
    mode: z.literal("live"),
    answer: z.string(),
  }),
);
export function prepareBlindMaterials(
  experimentDir: string,
  seed: number,
  track: "delivered" | "draft" = "delivered",
) {
  const root = resolve(experimentDir),
    data = loadDataset(resolve(root, "snapshot/dataset.json"));
  if (data.source !== "synthetic")
    throw Error(
      "Only explicitly authorized public synthetic experiments supported",
    );
  const suite = z
    .object({
      split: z.enum(["development", "validation", "test"]),
      cases: z.array(z.object({ id: z.string(), input: Request })),
    })
    .parse(readJson(resolve(root, "snapshot/suite.json")));
  const records = Rows.parse(readJson(resolve(root, "records.json")));
  const db = new DatabaseSync(resolve(root, "runs.sqlite"), { readOnly: true });
  const pairs = new Map<string, typeof records>();
  for (const row of records) {
    const id = JSON.stringify([row.caseId, row.repeat]);
    const pair = pairs.get(id) ?? [];
    pair.push(row);
    pairs.set(id, pair);
  }
  const cases: BlindBundle["cases"] = [],
    mapping: unknown[] = [],
    missing: unknown[] = [];
  const common = blindCommonSources(root, data);
  db.exec("BEGIN");
  try {
    for (const [pairId, pair] of pairs) {
      if (
        pair.length !== 2 ||
        new Set(pair.map((r) => r.architecture)).size !== 2
      )
        throw Error(
          "Every pair must contain exactly both architectures, including failed outputs",
        );
      const sourceCase = suite.cases.filter((c) => c.id === pair[0]!.caseId);
      if (sourceCase.length !== 1)
        throw Error("Missing or duplicate suite case");
      const request = sourceCase[0]!.input;
      const id = hash([seed, pairId, track]).slice(0, 24),
        order = [...pair].sort((a, b) =>
          a.architecture.localeCompare(b.architecture),
        );
      if (parseInt(hash([seed, pairId]).slice(0, 8), 16) % 2) order.reverse();
      const sources = [
        { id: "task", kind: "request", text: request.request },
        {
          id: "resume",
          kind: "resume",
          text: request.resumeText || "（未提供简历）",
        },
        {
          id: "constraints",
          kind: "request",
          text: JSON.stringify(request.constraints),
        },
        ...common,
      ];
      const candidates = order.map((r, i) => {
        const label = i === 0 ? ("A" as const) : ("B" as const);
        const row = db.prepare("select body from runs where id=?").get(r.runId);
        if (!row) throw Error("Run missing from database");
        const run = JSON.parse(String(row.body)) as RunRecord;
        if (
          run.mode !== "live" ||
          run.datasetVersion !== data.version ||
          run.request.architecture !== r.architecture ||
          (run.answer ?? "") !== r.answer
        )
          throw Error("Record/database provenance mismatch");
        if (["created", "running", "waiting_approval"].includes(run.status))
          throw Error("Cannot assess active run");
        if (
          run.memorySnapshot !== hash([]) ||
          Number(
            db
              .prepare("select count(*) as n from runs where user_id=?")
              .get(run.request.userId)?.n,
          ) !== 1
        )
          throw Error(
            "Memory or multi-turn materials require a dedicated exporter",
          );
        for (const field of ["request", "resumeText", "constraints"] as const)
          if (hash(run.request[field]) !== hash(request[field]))
            throw Error("Paired task mismatch");
        const arts = db
          .prepare("select body from artifacts where run_id=? order by step_id")
          .all(r.runId)
          .map((x) => JSON.parse(String(x.body)) as Artifact);
        // Execution facts are authoritative only for execution, never proof of personal claims.
        const attempts = db
          .prepare(
            "select body from artifact_history where run_id=? order by rowid",
          )
          .all(r.runId)
          .map((x) => JSON.parse(String(x.body)) as Artifact);
        sources.push({
          id: `execution:${label}`,
          kind: "control",
          text: JSON.stringify({
            candidate: label,
            current: arts.map((a) => ({
              stepId: a.stepId,
              expert: a.expert,
              attempt: a.attempt ?? 1,
              status: a.result.status,
              failureCode: a.failure?.code ?? null,
            })),
            attempts: attempts.map((a) => ({
              stepId: a.stepId,
              expert: a.expert,
              attempt: a.attempt ?? 1,
              status: a.result.status,
              failureCode: a.failure?.code ?? null,
            })),
          }),
        });
        let text = r.answer;
        if (track === "draft") {
          const drafts = db
            .prepare(
              "select key,result from tool_cache where run_id=? and key like ?",
            )
            .all(r.runId, "final:draft:%")
            .sort(
              (a, b) =>
                Number(String(a.key).split(":").at(-1)) -
                Number(String(b.key).split(":").at(-1)),
            );
          const last = drafts.at(-1);
          if (!last) {
            missing.push({ caseId: id, label, reason: "no-draft" });
            text = "";
          } else {
            const value: unknown = JSON.parse(String(last.result));
            if (typeof value !== "string") throw Error("Invalid draft receipt");
            text = value;
          }
        }
        mapping.push({
          caseId: id,
          pairId,
          track,
          label,
          runId: r.runId,
          architecture: r.architecture,
          originalAnswerHash: hash(text),
          status: run.status,
          finalReview: run.finalReview ?? null,
        });
        return { label, text };
      });
      cases.push({
        id,
        track,
        candidates,
        sources: sources.map((s) => ({ ...s, sha256: hash(s.text) })),
      });
    }
    const bundle = validateBundle({
      version: "blind-review-v1",
      dataClass: "public-synthetic",
      split: suite.split,
      seed,
      cases,
    });
    return {
      bundle,
      mapping,
      provenance: {
        bundleHash: hash(bundle),
        recordsHash: hash(readJson(resolve(root, "records.json"))),
        datasetHash: hash(data),
        suiteHash: hash(readJson(resolve(root, "snapshot/suite.json"))),
        missing,
        limitations: [
          "Body text may reveal architecture; preserved without rewriting",
          "All synthetic dataset sources included, no retrieval-dependent omission",
          "Single-request scenarios only; memory and multi-turn materials not yet supported",
        ],
      },
    };
  } finally {
    db.exec("ROLLBACK");
    db.close();
  }
}

export function blindCommonSources(
  root: string,
  data: ReturnType<typeof loadDataset>,
) {
  return [
    ...toolReferences(resolve(root, "snapshot")).map(
      ({ provenance, ...source }) => source,
    ),
    ...data.documents.map((d) => ({ id: d.id, kind: d.kind, text: d.text })),
    ...data.jobs.map((j) => ({
      id: `job:${j.id}`,
      kind: "job",
      text: JSON.stringify(j),
    })),
    ...data.categories.map((c) => ({
      id: `category:${c.id}`,
      kind: "category",
      text: JSON.stringify(c),
    })),
    ...data.edges.map((e) => ({
      id: `edge:${e.type}:${e.source}:${e.target}`,
      kind: "edge",
      text: JSON.stringify(e),
    })),
    ...["profile", "match", "path", "report"].map((role) => ({
      id: `rule:${role}`,
      kind: "rule",
      text: readFileSync(
        resolve(root, `snapshot/knowledge/${role}.md`),
        "utf8",
      ),
    })),
  ];
}
