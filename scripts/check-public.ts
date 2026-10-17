import { readdirSync, readFileSync, existsSync } from "node:fs";
import { resolve, relative, dirname } from "node:path";
import { ROOT, loadEnv } from "../src/config.js";
import { execFileSync } from "node:child_process";
loadEnv();
const excluded = new Set([
  ".git",
  ".private",
  ".models",
  ".npm-cache",
  "node_modules",
  "dist",
  "var",
  "tmp",
  "coverage",
]);
const errors: string[] = [];
const evaluationPublic = new Set([
  "README.md",
  "multi-agent-rationale.md",
  "results.md",
  "results.json",
]);
function localOnly(file: string) {
  return (
    /^(?:\.env$|\.env\.(?!example$)|\.private\/|\.planning\/|var\/|tmp\/|docs\/local\/|data\/(?:imported|private|indexes)\/)|(?:apikey.*\.txt|\.(?:sqlite|db))$/i.test(
      file,
    ) ||
    [
      "docs/architecture/source-evidence.md",
      "docs/architecture/cloud-adapter.md",
    ].includes(file) ||
    (file.startsWith("docs/evaluation/") &&
      !evaluationPublic.has(file.slice("docs/evaluation/".length))) ||
    (file.startsWith("docs/development/") &&
      !["implementation-status.md", "contributing.md"].includes(
        file.slice("docs/development/".length),
      )) ||
    /^docs\/(?:.*\/)?20\d{2}-\d{2}-\d{2}-[^/]+\.md$/.test(file)
  );
}
let publicPaths: Set<string> | undefined;
try {
  const tracked = execFileSync("git", ["ls-files", "-z"], {
    cwd: ROOT,
    encoding: "utf8",
  }).split("\0");
  for (const file of tracked)
    if (localOnly(file)) errors.push(`Private file is tracked by Git: ${file}`);
  publicPaths = new Set(
    execFileSync(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      {
        cwd: ROOT,
        encoding: "utf8",
      },
    )
      .split("\0")
      .filter(Boolean),
  );
} catch {
  // A source archive can fall back to policy-based content scanning. A checkout
  // must not silently pass without checking what Git would actually publish.
  if (existsSync(resolve(ROOT, ".git"))) {
    errors.push(
      "Cannot enumerate Git publication files; Git/link validation is incomplete.",
    );
  }
}
let count = 0;
function walk(dir: string) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name),
      rel = relative(ROOT, path).replaceAll("\\", "/");
    if (
      excluded.has(entry.name) ||
      ["data/private", "data/imported", "data/indexes", "results/raw"].some(
        (p) => rel === p || rel.startsWith(p + "/"),
      )
    )
      continue;
    if (
      entry.name === ".env" ||
      (entry.name.startsWith(".env.") && entry.name !== ".env.example") ||
      /apikey.*\.txt$/i.test(entry.name)
    )
      continue;
    if (entry.isDirectory()) {
      walk(path);
      continue;
    }
    if (localOnly(rel) || (publicPaths && !publicPaths.has(rel))) continue;
    if (!/\.(?:ts|js|mjs|json|md|ya?ml|example|txt)$/.test(entry.name))
      continue;
    count++;
    const text = readFileSync(path, "utf8");
    if (entry.name.endsWith(".md") && publicPaths) {
      for (const match of text.matchAll(/\]\(([^\s)]+)\)/g)) {
        const link = match[1]!;
        if (/^(?:[a-z][a-z\d+.-]*:|#|\/\/)/i.test(link)) continue;
        const target = relative(
          ROOT,
          resolve(
            dirname(path),
            decodeURIComponent(link.split("#")[0]!.split("?")[0]!),
          ),
        ).replaceAll("\\", "/");
        if (
          target.startsWith("../") ||
          localOnly(target) ||
          !(
            publicPaths.has(target) ||
            [...publicPaths].some((p) =>
              p.startsWith(target.replace(/\/$/, "") + "/"),
            )
          )
        ) {
          errors.push(
            `Non-public or missing documentation link in ${rel}: ${link}`,
          );
        }
      }
    }
    const key = process.env.CAREER_API_KEY;
    if (key && text.includes(key)) errors.push(`Credential found in ${rel}`);
    if (/\bsk-[A-Za-z0-9]{24,}\b/.test(text))
      errors.push(`Possible API credential found in ${rel}`);
    if (
      /(?:starting_balance|total_balance|EXPERIMENT_STOP_CNY)/.test(text) &&
      !rel.endsWith("check-public.ts")
    )
      errors.push(`Private operational information found in ${rel}`);
  }
}
walk(ROOT);
if (errors.length) {
  process.stderr.write(errors.join("\n") + "\n");
  process.exitCode = 1;
} else
  console.log(
    JSON.stringify({
      publicFilesChecked: count,
      gitPublicationChecked: publicPaths !== undefined,
      credentialExposure: false,
      privateOperationalData: false,
    }),
  );
