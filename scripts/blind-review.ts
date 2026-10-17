import { parseArgs } from "node:util";
import { resolve } from "node:path";
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  cpSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { backup } from "node:sqlite";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  config,
  loadEnv,
  hash,
  readJson,
  ROOT,
  implementationHash,
} from "../src/config.js";
import { prepareBlindMaterials } from "../src/blind-materials.js";
import { prepareConversationMaterials } from "../src/blind-conversations.js";
import { validateBundle } from "../src/blind-review.js";
import { BlindRunner } from "../src/blind-runner.js";
import { CompatibleProvider } from "../src/providers.js";
import type { ModelProvider } from "../src/contracts.js";
const { values: v } = parseArgs({
  options: {
    prepare: { type: "string" },
    "prepare-conversation": { type: "string" },
    bundle: { type: "string" },
    out: { type: "string" },
    seed: { type: "string", default: "20261015" },
    track: { type: "string", default: "delivered" },
    "confirm-public-synthetic": { type: "boolean" },
    live: { type: "boolean" },
    resume: { type: "boolean" },
    "retry-failed": { type: "boolean" },
  },
});
const digest = (path: string) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");
const list = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? list(resolve(dir, e.name)) : [resolve(dir, e.name)],
  );
async function main() {
  if (
    !v.out ||
    !v["confirm-public-synthetic"] ||
    [v.prepare, v["prepare-conversation"], v.bundle].filter(Boolean).length !==
      1
  )
    throw Error(
      "Use exactly one of --prepare EXPERIMENT, --prepare-conversation EXPERIMENT or --bundle FILE, with --out DIR and --confirm-public-synthetic after inspecting all input content",
    );
  const out = resolve(v.out);
  if (v.prepare || v["prepare-conversation"]) {
    if (v.resume || v.live || v["retry-failed"])
      throw Error("Preparation is offline and immutable");
    if (
      !["delivered", "draft"].includes(v.track!) ||
      !Number.isSafeInteger(Number(v.seed))
    )
      throw Error("Invalid seed or track");
    const prepare = v["prepare-conversation"]
      ? prepareConversationMaterials
      : prepareBlindMaterials;
    const result = prepare(
      (v["prepare-conversation"] ?? v.prepare)!,
      Number(v.seed),
      v.track as "delivered" | "draft",
    );
    mkdirSync(out, { recursive: false });
    for (const [name, value] of Object.entries({
      "bundle.json": result.bundle,
      "mapping.private.json": result.mapping,
      "provenance.json": result.provenance,
    }))
      writeFileSync(resolve(out, name), JSON.stringify(value, null, 2), {
        flag: "wx",
      });
    console.log(
      JSON.stringify({
        output: out,
        cases: result.bundle.cases.length,
        bundleHash: result.provenance.bundleHash,
      }),
    );
    return;
  }
  if (!v.live)
    throw Error(
      "AI review requires explicit --live; fixtures are only engineering tests",
    );
  const bundle = validateBundle(readJson(resolve(v.bundle!)));
  loadEnv();
  const cfg = config();
  if (v.resume) {
    if (!existsSync(resolve(out, "judge.sqlite")))
      throw Error("No existing review journal");
  } else {
    mkdirSync(out, { recursive: false });
    const snapshot = resolve(out, "snapshot");
    mkdirSync(snapshot);
    for (const name of [
      "src",
      "scripts",
      "package.json",
      "package-lock.json",
      "tsconfig.json",
    ])
      cpSync(resolve(ROOT, name), resolve(snapshot, name), { recursive: true });
    writeFileSync(
      resolve(out, "bundle.json"),
      JSON.stringify(bundle, null, 2),
      { flag: "wx" },
    );
    writeFileSync(
      resolve(out, "manifest.json"),
      JSON.stringify(
        {
          bundleHash: hash(bundle),
          implementationHash: implementationHash(),
          scriptHash: digest(resolve(ROOT, "scripts/blind-review.ts")),
          config: cfg,
          files: list(snapshot).map((path) => ({
            path: path.slice(out.length + 1),
            sha256: digest(path),
          })),
          createdAt: new Date().toISOString(),
          authorization:
            "Operator explicitly identified all materials as public synthetic",
        },
        null,
        2,
      ),
      { flag: "wx" },
    );
  }
  if (hash(readJson(resolve(out, "bundle.json"))) !== hash(bundle))
    throw Error("Frozen bundle mismatch");
  const manifest = readJson<{
    implementationHash: string;
    scriptHash: string;
    config: unknown;
    files: { path: string; sha256: string }[];
  }>(resolve(out, "manifest.json"));
  if (
    manifest.implementationHash !== implementationHash() ||
    manifest.scriptHash !== digest(resolve(ROOT, "scripts/blind-review.ts")) ||
    hash(manifest.config) !== hash(cfg) ||
    manifest.files.some((f) => digest(resolve(out, f.path)) !== f.sha256)
  )
    throw Error("Frozen implementation/configuration/snapshot mismatch");
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
  const runner = new BlindRunner(resolve(out, "judge.sqlite")),
    stop = new AbortController();
  const cancel = () => stop.abort();
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  try {
    const result = await runner.execute(bundle, provider, cfg, {
      retryFailed: v["retry-failed"],
      signal: stop.signal,
    });
    console.log(
      JSON.stringify({
        planned: result.planned,
        valid: result.valid,
        disagreements: result.disagreements,
      }),
    );
  } finally {
    // Each invocation exports a new result; the SQLite journal retains every attempt and frame.
    const name = `result-${Date.now()}.json`;
    writeFileSync(
      resolve(out, name),
      JSON.stringify(runner.summary(bundle), null, 2),
      { flag: "wx" },
    );
    writeFileSync(
      resolve(out, `${name}.sha256`),
      hash(readFileSync(resolve(out, name), "utf8")),
      { flag: "wx" },
    );
    try {
      const archive = resolve(out, `${name}.sqlite`);
      await backup(runner.store.db, archive);
      writeFileSync(`${archive}.sha256`, digest(archive), { flag: "wx" });
    } finally {
      runner.close();
      closeHook?.();
      process.off("SIGINT", cancel);
      process.off("SIGTERM", cancel);
    }
  }
}
main().catch(() => {
  console.error(
    "Blind review stopped; inspect preserved journal and input validation. No private operator details are printed.",
  );
  process.exitCode = 1;
});
