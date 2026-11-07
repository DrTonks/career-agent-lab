import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { config, loadEnv, ROOT, readJson } from "./config.js";
import { Store } from "./storage.js";
import { importLegacy, loadDataset } from "./data.js";
import { Knowledge } from "./retrieval.js";
import { CompatibleProvider, ReplayProvider } from "./providers.js";
import { Runtime } from "./runtime.js";
import { runMetrics } from "./evaluation.js";
import { buildIndex, ExactVectors } from "./vectors.js";
import { Role, type ModelProvider } from "./contracts.js";
loadEnv();
const { values: v, positionals: p } = parseArgs({
  allowPositionals: true,
  options: {
    case: { type: "string" },
    dataset: { type: "string" },
    db: { type: "string" },
    architecture: { type: "string" },
    user: { type: "string" },
    role: { type: "string" },
    query: { type: "string" },
    cursor: { type: "string" },
    limit: { type: "string" },
    inactive: { type: "boolean" },
    run: { type: "string" },
    approval: { type: "string" },
    live: { type: "boolean" },
    replay: { type: "string" },
    index: { type: "string" },
    out: { type: "string" },
    source: { type: "string" },
    bundle: { type: "string" },
    events: { type: "boolean" },
    confirm: { type: "boolean" },
  },
});
const output = (value: unknown) =>
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
async function main() {
  const command = p[0] ?? "help";
  if (command === "help") {
    output({
      commands: [
        "data import --source NODEBACKEND --bundle STEP5 --out DATASET",
        "index build --dataset FILE --out DIRECTORY",
        "run --case FILE --architecture multi-agent|skills --live",
        "run --case FILE --replay FIXTURE",
        "reply --run PARENT_ID --user USER --case REPLY_JSON --live",
        "resume --run ID --user USER --live",
        "approve|reject --run ID --user USER --approval ID --live",
        "inspect --run ID --user USER",
        "metrics --run ID --user USER",
        "cancel --run ID --user USER",
        "memory --user USER",
        "memory search --user USER --role EXPERT --query TEXT [--limit 8 --cursor CURSOR --inactive]",
        "memory history --user USER",
        "memory change --user USER --case CHANGE_JSON",
        "forget --user USER --confirm",
      ],
      notes: [
        "Use Node 24+. Live calls require local .env.",
        "No API key or private spending policy belongs in public source.",
        "A local .private/provider-hook.mjs may wrap the provider for operator policy.",
      ],
    });
    return;
  }
  if (command === "data" && p[1] === "import") {
    if (!v.source || !v.bundle || !v.out)
      throw new Error("--source --bundle --out required");
    output(importLegacy(resolve(v.source), resolve(v.out), resolve(v.bundle)));
    return;
  }
  const data = loadDataset(
    resolve(v.dataset ?? resolve(ROOT, "data/synthetic/dataset.json")),
  );
  let knowledge = new Knowledge(data);
  if (command === "index" && p[1] === "build") {
    if (!v.out) throw new Error("--out required");
    output(
      await buildIndex(
        knowledge,
        resolve(v.out),
        new AbortController().signal,
        (x) => process.stderr.write(JSON.stringify(x) + "\n"),
      ),
    );
    return;
  }
  const store = new Store(resolve(v.db ?? resolve(ROOT, "var/runtime.sqlite")));
  let closeHook: (() => void) | undefined;
  try {
    if (command === "memory") {
      if (!v.user) throw new Error("--user required");
      if (p[1] === "search") {
        const role =
          v.role === "orchestrator" ? "orchestrator" : Role.parse(v.role);
        output(
          store.recallMemories(v.user, role, {
            query: v.query,
            limit: v.limit === undefined ? undefined : Number(v.limit),
            cursor: v.cursor,
            includeInactive: v.inactive,
          }),
        );
        return;
      }
      if (p[1] === "change") {
        if (!v.case)
          throw new Error(
            "--case required for explicit memory correction/retraction",
          );
        output(store.changeMemory(v.user, readJson(resolve(v.case))));
        return;
      }
      if (p[1] === "history") {
        output({
          versions: store.memoryHeads(v.user),
          history: store.memoryHistory(v.user),
        });
        return;
      }
      if (p[1]) throw new Error("Unknown memory command");
      output(
        ["orchestrator", "profile", "match", "path", "report"].map((role) => ({
          role,
          items: store.memories(v.user!, role as any),
          versions: store.memoryHeads(v.user!, role as any),
        })),
      );
      return;
    }
    if (command === "forget") {
      if (!v.user || !v.confirm)
        throw new Error("--user and --confirm required");
      store.forgetUser(v.user);
      output({ erased: true });
      return;
    }
    if (["inspect", "metrics", "cancel"].includes(command)) {
      if (!v.run || !v.user) throw new Error("--run --user required");
      store.run(v.run, v.user);
      if (command === "inspect")
        output({
          run: store.run(v.run),
          artifacts: store.artifacts(v.run),
          artifactHistory: store.artifactHistory(v.run),
          memoryProposals: store.proposals(v.run),
          approval: store.approval(v.run),
          events: store.events(v.run),
        });
      else if (command === "metrics") output(runMetrics(store, v.run));
      else {
        store.cancel(v.run, v.user);
        output({ cancelled: true });
      }
      return;
    }
    const cfg = config();
    let provider: ModelProvider;
    if (v.live && v.replay)
      throw new Error("Choose --live or --replay, never both");
    if (v.live) {
      provider = new CompatibleProvider(cfg, process.env.CAREER_API_KEY ?? "");
      const hookPath = resolve(ROOT, ".private/provider-hook.mjs");
      if (existsSync(hookPath)) {
        const hook = await import(pathToFileURL(hookPath).href);
        const wrapped = await hook.wrap(provider, cfg);
        provider = wrapped.provider;
        closeHook = wrapped.close;
      }
    } else if (v.replay)
      provider = new ReplayProvider(readJson(resolve(v.replay)));
    else
      throw new Error(
        "Explicit --live or --replay required; no silent mock fallback",
      );
    if (v.index) {
      const vectors = new ExactVectors(
        resolve(v.index),
        knowledge.snapshotHash,
      );
      knowledge = new Knowledge(data, vectors);
    }
    if (v.events)
      store.onEvent = (e) => process.stderr.write(JSON.stringify(e) + "\n");
    const runtime = new Runtime(store, knowledge, provider, cfg);
    let id: string, user: string;
    if (command === "run") {
      if (!v.case) throw new Error("--case required");
      const request = readJson<Record<string, unknown>>(resolve(v.case));
      if (v.architecture) request.architecture = v.architecture;
      if (v.user) request.userId = v.user;
      const run = runtime.create(request);
      id = run.id;
      user = run.request.userId;
    } else if (command === "reply") {
      if (!v.run || !v.user || !v.case)
        throw Error("reply requires --run --user --case");
      if (v.architecture)
        throw Error("reply preserves the parent architecture");
      const child = runtime.reply(v.run, v.user, readJson(resolve(v.case)));
      id = child.id;
      user = child.request.userId;
      if (
        [
          "succeeded",
          "partial",
          "rejected",
          "cancelled",
          "stale",
          "waiting_approval",
        ].includes(child.status)
      ) {
        output({ run: child, metrics: runMetrics(store, id), reused: true });
        return;
      }
    } else {
      if (!v.run || !v.user) throw new Error("--run --user required");
      id = v.run;
      user = v.user;
    }
    if (!["run", "reply", "resume", "approve", "reject"].includes(command))
      throw new Error("Unknown command");
    if (["approve", "reject"].includes(command) && !v.approval)
      throw new Error("--approval required");
    const run = await runtime.execute(
      id,
      user,
      ["approve", "reject"].includes(command)
        ? { decision: command as "approve" | "reject", approvalId: v.approval! }
        : undefined,
    );
    output({ run, metrics: runMetrics(store, id) });
    if (run.status === "failed") process.exitCode = 1;
  } finally {
    store.close();
    closeHook?.();
  }
}
main().catch((e) => {
  process.stderr.write(
    JSON.stringify({ error: e instanceof Error ? e.message : String(e) }) +
      "\n",
  );
  process.exitCode = 1;
});
