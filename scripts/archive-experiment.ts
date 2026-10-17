import { DatabaseSync, backup } from "node:sqlite";
import {
  mkdirSync,
  readdirSync,
  writeFileSync,
  cpSync,
  existsSync,
  createReadStream,
  statSync,
} from "node:fs";
import { resolve, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { parseArgs } from "node:util";

export async function archiveExperiment(
  dbPath: string,
  outDirectory: string,
  experimentDirectory?: string,
) {
  if (!existsSync(dbPath)) throw new Error("Source database does not exist");
  const id =
    new Date().toISOString().replace(/[:.]/g, "-") +
    "-" +
    randomUUID().slice(0, 8);
  const out = resolve(outDirectory, "archives", id);
  mkdirSync(out, { recursive: true });
  const source = new DatabaseSync(resolve(dbPath), { readOnly: true });
  try {
    await backup(source, resolve(out, "runs.sqlite"));
  } finally {
    source.close();
  }
  const db = new DatabaseSync(resolve(out, "runs.sqlite"), { readOnly: true });
  const tables = new Set(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => String(r.name)),
  );
  const counts: Record<string, number> = {};
  const limitations: string[] = [];
  try {
    if (db.prepare("PRAGMA integrity_check").get()!.integrity_check !== "ok")
      throw new Error("Archive database integrity check failed");
    mkdirSync(resolve(out, "exports"));
    // Fixed table allowlist. Binary checkpoints remain fully preserved in SQLite.
    for (const table of [
      "runs",
      "events",
      "artifacts",
      "artifact_history",
      "model_calls",
      "proposals",
      "memories",
      "memory_history",
      "memory_commands",
      "approvals",
      "tool_cache",
      "constraints",
      "conversation_inputs",
      "follow_up_commands",
      "leases",
    ]) {
      if (!tables.has(table)) {
        limitations.push(`Missing historical table: ${table}`);
        continue;
      }
      const rows = db.prepare(`SELECT * FROM ${table}`).all();
      const parsed = rows.map((row) =>
        Object.fromEntries(
          Object.entries(row).map(([key, value]) => {
            if (
              ["body", "result", "evidence", "origin"].includes(key) &&
              typeof value === "string"
            ) {
              try {
                return [key, JSON.parse(value)];
              } catch {
                /* Preserve original malformed historical value. */
              }
            }
            return [key, value];
          }),
        ),
      );
      counts[table] = rows.length;
      writeFileSync(
        resolve(out, "exports", `${table}.json`),
        JSON.stringify(parsed, null, 2),
      );
    }
    if (tables.has("runs")) {
      const unfinished = db
        .prepare("SELECT body FROM runs")
        .all()
        .map((r) => JSON.parse(String(r.body)))
        .filter((r) =>
          ["created", "running", "waiting_approval"].includes(r.status),
        );
      if (unfinished.length)
        limitations.push(
          `${unfinished.length} recorded runs are not terminal; original states preserved, not inferred.`,
        );
    }
    if (tables.has("model_calls")) {
      const missing = db
        .prepare("SELECT body FROM model_calls")
        .all()
        .map((r) => JSON.parse(String(r.body)))
        .filter((r) => r.response === undefined);
      if (missing.length)
        limitations.push(
          `${missing.length} model calls lack a stored response; archival cannot reconstruct missing partial streams.`,
        );
    }
  } finally {
    db.close();
  }
  if (experimentDirectory) {
    const material = resolve(out, "materials");
    mkdirSync(material);
    for (const entry of readdirSync(experimentDirectory, {
      withFileTypes: true,
    })) {
      if (entry.isSymbolicLink()) continue;
      const allowed = entry.isDirectory()
        ? ["snapshot", "analysis"].includes(entry.name)
        : ["experiment.json", "records.json"].includes(entry.name) ||
          entry.name.endsWith(".trace.json");
      if (allowed)
        cpSync(
          resolve(experimentDirectory, entry.name),
          resolve(material, entry.name),
          { recursive: true },
        );
    }
    if (!existsSync(resolve(experimentDirectory, "snapshot")))
      limitations.push(
        "No historical code/data snapshot directory; not reconstructed.",
      );
    if (!existsSync(resolve(experimentDirectory, "records.json")))
      limitations.push(
        "No final metrics export; consult the archived database and events.",
      );
  } else
    limitations.push(
      "Legacy standalone database; related original logs remain at their original paths.",
    );
  const files: Array<{ path: string; bytes: number; sha256: string }> = [];
  async function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const path = resolve(dir, entry.name);
      if (entry.isSymbolicLink())
        throw new Error("Symbolic links are not permitted in archives");
      if (entry.isDirectory()) await walk(path);
      else {
        const digest = createHash("sha256");
        for await (const part of createReadStream(path)) digest.update(part);
        files.push({
          path: relative(out, path).replaceAll("\\", "/"),
          bytes: statSync(path).size,
          sha256: digest.digest("hex"),
        });
      }
    }
  }
  await walk(out);
  const manifest = {
    schemaVersion: 1,
    archiveId: id,
    createdAt: new Date().toISOString(),
    sourceDatabase: resolve(dbPath),
    counts,
    limitations,
    files,
    note: "Consistent database snapshot plus all available allowlisted materials. Missing historical information is not fabricated. No credentials or private operator files are intentionally collected.",
  };
  writeFileSync(
    resolve(out, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
  return {
    directory: out,
    archiveId: id,
    counts,
    limitations,
    fileCount: files.length,
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const { values: v } = parseArgs({
    options: {
      experiment: { type: "string" },
      db: { type: "string" },
      out: { type: "string" },
    },
  });
  if (v.experiment && v.db) throw new Error("Choose --experiment or --db");
  if (!v.experiment && !(v.db && v.out))
    throw new Error("Use --experiment DIRECTORY or --db FILE --out DIRECTORY");
  const experiment = v.experiment ? resolve(v.experiment) : undefined;
  const result = await archiveExperiment(
    experiment ? resolve(experiment, "runs.sqlite") : resolve(v.db!),
    resolve(v.out ?? experiment!),
    experiment,
  );
  console.log(JSON.stringify(result));
}
