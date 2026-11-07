import { z } from "zod";
import {
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import {
  Architecture,
  FollowUp,
  Request,
  Role,
  type ModelProvider,
} from "./contracts.js";
import { hash, implementationHash, ROOT, type Config } from "./config.js";
import { loadDataset } from "./data.js";
import { Knowledge } from "./retrieval.js";
import { Store } from "./storage.js";
import { Runtime } from "./runtime.js";
import { ExactVectors } from "./vectors.js";
import { runMetrics } from "./evaluation.js";

export const ComparisonSuite = z
  .object({
    schemaVersion: z.literal("comparison-suite-v1"),
    name: z.string().min(1),
    split: z.literal("development"),
    seed: z.number().int().positive(),
    repeats: z.number().int().min(1).max(10),
    cases: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
            stratum: z.enum([
              "single-domain",
              "cross-domain",
              "constraints",
              "evidence",
              "conversation",
              "memory",
            ]),
            first: Request,
            replies: z.array(FollowUp).max(19),
            approval: z.enum(["none", "approve", "reject"]).default("none"),
            expected: z.object({
              requiredRoles: z.array(Role),
              checks: z.array(z.string().min(1)).min(1),
            }),
          })
          .strict(),
      )
      .min(1),
  })
  .strict()
  .superRefine((s, ctx) => {
    if (new Set(s.cases.map((c) => c.id)).size !== s.cases.length)
      ctx.addIssue({ code: "custom", message: "Duplicate case IDs" });
    for (const c of s.cases)
      if (
        new Set(c.replies.map((r) => r.operationId)).size !== c.replies.length
      )
        ctx.addIssue({
          code: "custom",
          message: "Duplicate reply operation IDs",
        });
  });
export type ComparisonSuite = z.infer<typeof ComparisonSuite>;
export interface ComparisonPlan {
  schemaVersion: "comparison-plan-v1";
  experiment: string;
  suite: ComparisonSuite;
  config: Config;
  implementationHash: string;
  files: { path: string; sha256: string }[];
  units: {
    id: string;
    caseId: string;
    repeat: number;
    architecture: z.infer<typeof Architecture>;
  }[];
  hash: string;
}
const read = <T>(p: string): T => JSON.parse(readFileSync(p, "utf8"));
const fileHash = (p: string) =>
  createHash("sha256").update(readFileSync(p)).digest("hex");
const save = (p: string, v: unknown) => {
  const tmp = p + ".tmp";
  writeFileSync(tmp, JSON.stringify(v, null, 2));
  renameSync(tmp, p);
};
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.isSymbolicLink()) throw Error("Snapshot symlinks not allowed");
    const p = resolve(dir, e.name);
    return e.isDirectory() ? files(p) : [p];
  });
}
export function prepareComparison(
  out: string,
  input: unknown,
  cfg: Config,
  index?: string,
) {
  const suite = ComparisonSuite.parse(input);
  if (existsSync(out))
    throw Error("Comparison directory already exists; never overwrite a batch");
  if (!cfg.model)
    throw Error("Explicit model required for a frozen comparison");
  const data = loadDataset(resolve(ROOT, "data/synthetic/dataset.json"));
  if (data.source !== "synthetic")
    throw Error("Only public synthetic comparison supported");
  mkdirSync(resolve(out, "snapshot"), { recursive: true });
  for (const path of [
    "src",
    "scripts",
    "tests",
    "prompts",
    "knowledge",
    "skills",
    "evals",
    "package.json",
    "package-lock.json",
    "tsconfig.json",
  ])
    cpSync(resolve(ROOT, path), resolve(out, "snapshot", path), {
      recursive: true,
    });
  save(resolve(out, "snapshot/dataset.json"), data);
  if (index) {
    const knowledge = new Knowledge(data),
      vectors = new ExactVectors(resolve(index), knowledge.snapshotHash);
    mkdirSync(resolve(out, "snapshot/index"));
    for (const f of ["manifest.json", vectors.manifest.vectorFile])
      cpSync(resolve(index, f), resolve(out, "snapshot/index", f));
  }
  let seed = suite.seed >>> 0;
  const random = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 4294967296;
  };
  const cases = [...suite.cases];
  for (let i = cases.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [cases[i], cases[j]] = [cases[j]!, cases[i]!];
  }
  const units: ComparisonPlan["units"] = [];
  for (const c of cases) {
    const first = random() < 0.5;
    for (let repeat = 0; repeat < suite.repeats; repeat++)
      for (const architecture of (first !== (repeat % 2 === 1)
        ? ["multi-agent", "skills"]
        : ["skills", "multi-agent"]) as z.infer<typeof Architecture>[])
        units.push({
          id: `${c.id}-r${repeat}-${architecture}`,
          caseId: c.id,
          repeat,
          architecture,
        });
  }
  const body = {
    schemaVersion: "comparison-plan-v1" as const,
    experiment: randomUUID(),
    suite,
    config: cfg,
    implementationHash: implementationHash(),
    files: files(resolve(out, "snapshot")).map((p) => ({
      path: relative(resolve(out, "snapshot"), p).replaceAll("\\", "/"),
      sha256: fileHash(p),
    })),
    units,
  };
  const plan = { ...body, hash: hash(body) };
  save(resolve(out, "plan.json"), plan);
  save(resolve(out, "status.json"), {
    planHash: plan.hash,
    units: units.map((u) => ({ ...u, status: "scheduled" })),
  });
  return plan;
}
export function verifyComparison(out: string) {
  const plan = read<ComparisonPlan>(resolve(out, "plan.json"));
  const { hash: expected, ...body } = plan;
  if (hash(body) !== expected) throw Error("Comparison plan hash mismatch");
  ComparisonSuite.parse(plan.suite);
  if (implementationHash() !== plan.implementationHash)
    throw Error("Implementation changed; prepare a new batch");
  for (const f of plan.files) {
    const inside = relative(
      resolve(out, "snapshot"),
      resolve(out, "snapshot", f.path),
    );
    if (inside.startsWith("..") || isAbsolute(inside))
      throw Error("Invalid snapshot path");
    if (fileHash(resolve(out, "snapshot", f.path)) !== f.sha256)
      throw Error("Frozen snapshot changed: " + f.path);
    if (
      !["dataset.json"].includes(f.path) &&
      !f.path.startsWith("index/") &&
      fileHash(resolve(ROOT, f.path)) !== f.sha256
    )
      throw Error("Current source/dependencies differ: " + f.path);
  }
  return plan;
}

/** One isolated architecture/conversation unit. A fresh CLI process runs each unit.
 * The batch lock prevents overlapping writers; interrupted units require explicit
 * resume. The database, not a transient JSON counter, is the recovery authority.
 */
export async function executeComparisonUnit(
  out: string,
  unitId: string,
  provider: ModelProvider,
  resume = false,
) {
  const plan = verifyComparison(out),
    unit = plan.units.find((u) => u.id === unitId);
  if (!unit) throw Error("Unknown comparison unit");
  const statusPath = resolve(out, "status.json");
  const lock = resolve(out, "active.lock");
  if (existsSync(lock)) {
    if (!resume)
      throw Error("Batch lock exists; inspect and explicitly resume");
    const prior = read<{ pid: number }>(lock);
    if (!Number.isSafeInteger(prior.pid) || prior.pid <= 0)
      throw Error("Invalid lock identity");
    let alive = true;
    try {
      process.kill(prior.pid, 0);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ESRCH") alive = false;
      else throw e;
    }
    if (alive) throw Error("Comparison process still alive");
    unlinkSync(lock);
  }
  const fd = openSync(lock, "wx");
  writeFileSync(
    fd,
    JSON.stringify({ pid: process.pid, unitId, planHash: plan.hash }),
  );
  closeSync(fd);
  const status = read<any>(statusPath);
  let store: Store | undefined;
  const mark = (state: string, extra: Record<string, unknown> = {}) => {
    const entry = status.units.find((u: any) => u.id === unitId);
    Object.assign(entry, { status: state, ...extra });
    save(statusPath, status);
    appendFileSync(
      resolve(out, "transitions.jsonl"),
      JSON.stringify({
        at: new Date().toISOString(),
        unitId,
        status: state,
        ...extra,
      }) + "\n",
    );
  };
  try {
    if (status.planHash !== plan.hash)
      throw Error("Status belongs to another plan");
    const entry = status.units.find((u: any) => u.id === unitId);
    if (!entry) throw Error("Missing unit status");
    if (["completed", "blocked"].includes(entry.status)) return entry;
    if (entry.status !== "scheduled" && !resume)
      throw Error("Interrupted unit requires explicit resume");
    mark("running");
    const c = plan.suite.cases.find((c) => c.id === unit.caseId)!,
      pair = resolve(out, "pairs", `${c.id}-r${unit.repeat}`);
    mkdirSync(pair, { recursive: true });
    if (!existsSync(resolve(pair, "snapshot")))
      cpSync(resolve(out, "snapshot"), resolve(pair, "snapshot"), {
        recursive: true,
      });
    save(resolve(pair, "snapshot/suite.json"), {
      name: plan.suite.name,
      split: plan.suite.split,
      cases: [{ id: c.id, input: c.first }],
    });
    save(resolve(pair, "scenario.json"), {
      ...(c.stratum === "memory"
        ? { memoryPolicy: "recorded-approvals-v1" }
        : {}),
      first: c.first,
      replies: c.replies,
      architectures: ["multi-agent", "skills"],
      turns: 1 + c.replies.length,
    });
    save(resolve(pair, "experiment.json"), {
      experiment: plan.experiment,
      caseId: c.id,
      repeat: unit.repeat,
      planHash: plan.hash,
      config: plan.config,
      mode: provider.mode,
    });
    const data = loadDataset(resolve(out, "snapshot/dataset.json")),
      base = new Knowledge(data),
      index = resolve(out, "snapshot/index");
    const knowledge = existsSync(index)
      ? new Knowledge(data, new ExactVectors(index, base.snapshotHash))
      : base;
    store = new Store(resolve(pair, "runs.sqlite"));
    const rt = new Runtime(store, knowledge, provider, plan.config),
      userId = `synthetic:${plan.experiment}:${unitId}`;
    const rootRows = store.db
      .prepare("SELECT body FROM runs WHERE user_id=?")
      .all(userId)
      .map((r) => JSON.parse(String(r.body)))
      .filter((r) => !r.continuation);
    if (rootRows.length > 1) throw Error("Duplicate evaluation roots");
    let run =
      rootRows[0] ??
      rt.create({
        ...c.first,
        userId,
        conversationId: `comparison-${c.id}`,
        architecture: unit.architecture,
      });
    const recordsPath = resolve(pair, "records.json"),
      records = existsSync(recordsPath) ? read<any[]>(recordsPath) : [];
    for (let turn = 1; turn <= 1 + c.replies.length; turn++) {
      if (turn > 1) {
        if (!["partial", "succeeded"].includes(run.status)) {
          mark("blocked", {
            completedTurns: turn - 1,
            blockedTurns: 1 + c.replies.length - turn + 1,
            reason: `Parent status ${run.status}`,
          });
          return status.units.find((u: any) => u.id === unitId);
        }
        run = rt.reply(run.id, userId, c.replies[turn - 2]!);
      }
      save(resolve(pair, `${run.id}.request.json`), {
        request: run.request,
        continuation: run.continuation ?? null,
      });
      if (!["partial", "succeeded", "failed", "cancelled"].includes(run.status))
        run = await rt.execute(run.id, userId);
      if (run.status === "waiting_approval" && c.approval !== "none") {
        const approval = store
          .events(run.id)
          .findLast((e) => e.type === "approval.required")?.payload as
          { approvalId?: string } | undefined;
        if (!approval?.approvalId) throw Error("Approval snapshot missing");
        store.event(run.id, "evaluation.scripted_approval", {
          caseId: c.id,
          decision: c.approval,
          syntheticOnly: true,
        });
        run = await rt.execute(run.id, userId, {
          approvalId: approval.approvalId,
          decision: c.approval,
        });
      }
      const row = {
        caseId: c.id,
        repeat: unit.repeat,
        turn,
        ...runMetrics(store, run.id),
        answer: run.answer ?? "",
        expectation: c.expected,
        qualityScore: null,
      };
      const old = records.findIndex(
        (r) => r.architecture === unit.architecture && r.turn === turn,
      );
      if (old >= 0) records[old] = row;
      else records.push(row);
      save(recordsPath, records);
      save(resolve(pair, `${run.id}.trace.json`), store.events(run.id));
      if (run.status === "waiting_approval") {
        mark("blocked", {
          reason: "Unscripted approval pending",
          completedTurns: turn - 1,
          blockedTurns: 2 + c.replies.length - turn,
        });
        return status.units.find((u: any) => u.id === unitId);
      }
    }
    mark("completed", { completedTurns: 1 + c.replies.length });
    return status.units.find((u: any) => u.id === unitId);
  } catch (e) {
    mark("interrupted", { error: e instanceof Error ? e.message : String(e) });
    throw e;
  } finally {
    store?.close();
    unlinkSync(lock);
  }
}
