import { parseArgs } from "node:util";
import { mkdirSync, writeFileSync, existsSync, cpSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  config,
  loadEnv,
  readJson,
  ROOT,
  implementationHash,
  hash,
} from "../src/config.js";
import { Request, type ModelProvider } from "../src/contracts.js";
import { Store } from "../src/storage.js";
import { loadDataset } from "../src/data.js";
import { Knowledge } from "../src/retrieval.js";
import { ExactVectors } from "../src/vectors.js";
import { CompatibleProvider } from "../src/providers.js";
import { Runtime } from "../src/runtime.js";
import { runMetrics } from "../src/evaluation.js";
import { archiveExperiment } from "./archive-experiment.js";
const Suite = z.object({
  name: z.string(),
  split: z.enum(["development", "validation", "test"]),
  seed: z.number().int(),
  cases: z
    .array(
      z.object({
        id: z.string(),
        input: Request,
        expected: z.object({
          requiredRoles: z.array(z.string()),
          notes: z.string(),
        }),
      }),
    )
    .min(1),
});
loadEnv();
const { values: v } = parseArgs({
  options: {
    suite: { type: "string" },
    dataset: { type: "string" },
    index: { type: "string" },
    out: { type: "string" },
    repeats: { type: "string", default: "1" },
    live: { type: "boolean" },
  },
});
async function main() {
  if (!v.suite || !v.live)
    throw new Error(
      "Explicit --suite FILE --live required; no replay quality benchmark",
    );
  const suite = Suite.parse(readJson(resolve(v.suite))),
    repeats = Number(v.repeats);
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 10)
    throw new Error("repeats must be 1..10");
  const experiment = randomUUID(),
    out = resolve(v.out ?? resolve(ROOT, "var/experiments", experiment));
  if (existsSync(out))
    throw new Error(
      "Experiment output already exists; choose a new directory to preserve all prior records",
    );
  mkdirSync(out, { recursive: true });
  const data = loadDataset(
    resolve(v.dataset ?? resolve(ROOT, "data/synthetic/dataset.json")),
  );
  let knowledge = new Knowledge(data);
  if (v.index)
    knowledge = new Knowledge(
      data,
      new ExactVectors(resolve(v.index), knowledge.snapshotHash),
    );
  const cfg = config();
  const snapshot = resolve(out, "snapshot");
  mkdirSync(snapshot, { recursive: true });
  // Explicit allowlist: never snapshot .env, credentials or operator hooks.
  for (const entry of [
    "src",
    "prompts",
    "knowledge",
    "skills",
    "scripts",
    "package.json",
    "package-lock.json",
    "tsconfig.json",
  ])
    cpSync(resolve(ROOT, entry), resolve(snapshot, entry), { recursive: true });
  writeFileSync(resolve(snapshot, "dataset.json"), JSON.stringify(data));
  writeFileSync(resolve(snapshot, "suite.json"), JSON.stringify(suite));
  if (v.index) {
    const index = resolve(v.index);
    mkdirSync(resolve(snapshot, "index"));
    for (const name of [
      "manifest.json",
      (knowledge.vectors as ExactVectors).manifest.vectorFile,
    ])
      cpSync(resolve(index, name), resolve(snapshot, "index", name));
  }
  let provider: ModelProvider = new CompatibleProvider(
      cfg,
      process.env.CAREER_API_KEY ?? "",
    ),
    closeHook: (() => void) | undefined;
  const hookPath = resolve(ROOT, ".private/provider-hook.mjs");
  if (existsSync(hookPath)) {
    const hook = await import(pathToFileURL(hookPath).href);
    const wrapped = await hook.wrap(provider, cfg);
    provider = wrapped.provider;
    closeHook = wrapped.close;
  }
  let seed = suite.seed >>> 0;
  const random = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 4294967296;
  };
  const schedule = suite.cases.flatMap((c) =>
    Array.from({ length: repeats }, (_, repeat) => ({
      c,
      repeat,
      architectures:
        random() < 0.5 ? ["multi-agent", "skills"] : ["skills", "multi-agent"],
    })),
  );
  writeFileSync(
    resolve(out, "experiment.json"),
    JSON.stringify(
      {
        experiment,
        suite: suite.name,
        split: suite.split,
        seed: suite.seed,
        repeats,
        config: cfg,
        implementationHash: implementationHash(),
        dependencyHash: hash(readJson(resolve(ROOT, "package-lock.json"))),
        environment: {
          node: process.version,
          platform: process.platform,
          arch: process.arch,
        },
        datasetVersion: data.version,
        knowledgeHash: knowledge.snapshotHash,
        schedule: schedule.map((s) => ({
          case: s.c.id,
          repeat: s.repeat,
          order: s.architectures,
        })),
        qualityStatus: "requires independent blind review",
      },
      null,
      2,
    ),
  );
  const records: unknown[] = [];
  try {
    for (const scheduled of schedule)
      for (const architecture of scheduled.architectures) {
        const store = new Store(resolve(out, "runs.sqlite"));
        try {
          const runtime = new Runtime(store, knowledge, provider, cfg);
          const run = runtime.create({
            ...scheduled.c.input,
            architecture,
            userId: `synthetic:${experiment}:${scheduled.c.id}:${scheduled.repeat}:${architecture}`,
            conversationId: "isolated-evaluation",
          });
          let done = await runtime.execute(run.id, run.request.userId);
          // Synthetic benchmark consent is scripted and recorded, never applied to actual user data.
          if (
            done.status === "waiting_approval" &&
            data.source === "synthetic"
          ) {
            const approval = store
              .events(run.id)
              .findLast((e) => e.type === "approval.required")?.payload as
              { approvalId: string } | undefined;
            if (approval) {
              store.event(run.id, "evaluation.scripted_approval", {
                scenario: scheduled.c.id,
                syntheticOnly: true,
              });
              done = await runtime.execute(run.id, run.request.userId, {
                decision: "approve",
                approvalId: approval.approvalId,
              });
            }
          }
          const metrics = runMetrics(store, run.id),
            roles = store.artifacts(run.id).map((a) => a.expert);
          const record = {
            caseId: scheduled.c.id,
            repeat: scheduled.repeat,
            ...metrics,
            requiredRolesCovered: scheduled.c.expected.requiredRoles.every(
              (r) => roles.includes(r as any),
            ),
            answer: done.answer ?? "",
            expectation: scheduled.c.expected,
            qualityScore: null,
            artifacts: store.artifacts(run.id).map((a) => ({
              expert: a.expert,
              status: a.result.status,
              evidenceCount: a.result.evidenceIds.length,
              markdown:
                a.expert === "report" ? a.result.artifact.markdown : undefined,
            })),
          };
          records.push(record);
          writeFileSync(
            resolve(out, "records.json"),
            JSON.stringify(records, null, 2),
          );
          writeFileSync(
            resolve(out, `${run.id}.trace.json`),
            JSON.stringify(store.events(run.id), null, 2),
          );
          process.stdout.write(
            JSON.stringify({
              caseId: scheduled.c.id,
              architecture,
              status: done.status,
              modelCalls: metrics.modelCalls,
            }) + "\n",
          );
          if (
            done.error?.includes("spending") ||
            done.error?.includes("balance")
          )
            throw new Error("Local operator policy stopped the experiment");
        } finally {
          store.close();
        }
      }
  } finally {
    closeHook?.();
    const database = resolve(out, "runs.sqlite");
    if (existsSync(database)) {
      const archived = await archiveExperiment(database, out, out);
      process.stdout.write(
        JSON.stringify({
          archive: archived.directory,
          limitations: archived.limitations,
        }) + "\n",
      );
    }
  }
  process.stdout.write(
    JSON.stringify({
      experiment,
      output: out,
      runs: records.length,
      warning:
        "Operational pilot only. No human quality labels and no architecture superiority claim.",
    }) + "\n",
  );
}
main().catch((e) => {
  process.stderr.write(
    JSON.stringify({ error: e instanceof Error ? e.message : String(e) }) +
      "\n",
  );
  process.exitCode = 1;
});
