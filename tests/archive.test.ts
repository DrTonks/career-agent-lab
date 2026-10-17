import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { ROOT } from "../src/config.js";
import { archiveExperiment } from "../scripts/archive-experiment.js";

test("archive captures WAL data, exports available responses and preserves interrupted states", async () => {
  mkdirSync(resolve(ROOT, "tmp/tests"), { recursive: true });
  const root = mkdtempSync(resolve(ROOT, "tmp/tests/archive-")),
    path = resolve(root, "source.sqlite");
  const db = new DatabaseSync(path);
  db.exec(
    "PRAGMA journal_mode=WAL;CREATE TABLE runs(body TEXT);CREATE TABLE model_calls(body TEXT);",
  );
  db.prepare("INSERT INTO runs VALUES(?)").run(
    JSON.stringify({ id: "r", status: "running" }),
  );
  db.prepare("INSERT INTO model_calls VALUES(?)").run(
    JSON.stringify({ status: "failed", error: "interrupted" }),
  );
  const result = await archiveExperiment(path, resolve(root, "output"));
  assert.equal(
    JSON.parse(String(db.prepare("SELECT body FROM runs").get()!.body)).status,
    "running",
  );
  const snapshot = new DatabaseSync(resolve(result.directory, "runs.sqlite"), {
    readOnly: true,
  });
  assert.equal(snapshot.prepare("SELECT COUNT(*) n FROM runs").get()!.n, 1);
  snapshot.close();
  db.close();
  assert.ok(result.limitations.some((x) => x.includes("not terminal")));
  assert.ok(
    result.limitations.some((x) => x.includes("lack a stored response")),
  );
  const manifest = JSON.parse(
    readFileSync(resolve(result.directory, "manifest.json"), "utf8"),
  );
  for (const file of manifest.files)
    assert.equal(
      createHash("sha256")
        .update(readFileSync(resolve(result.directory, file.path)))
        .digest("hex"),
      file.sha256,
    );
});
