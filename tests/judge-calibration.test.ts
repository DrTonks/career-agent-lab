import test from "node:test";
import assert from "node:assert/strict";
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { config, ROOT, hash } from "../src/config.js";
import { toolReferences } from "../src/tool-reference.js";
import {
  calibrationMaterials,
  analyzeCalibration,
} from "../src/judge-calibration.js";
import { BlindRunner } from "../src/blind-runner.js";
import { reviewRequest, reviewSchedule } from "../src/blind-review.js";
import { blindProvider } from "./fixtures/blind-provider.js";
test("historical tool references retain exact code provenance without executing or substituting current code", () => {
  const root = resolve(ROOT, "var/tests");
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(resolve(root, "tool-reference-"));
  mkdirSync(resolve(dir, "src"));
  for (const file of ["tools.ts", "retrieval.ts"])
    cpSync(resolve(ROOT, "src", file), resolve(dir, "src", file));
  const file = resolve(dir, "src/tools.ts"),
    changed = readFileSync(file, "utf8").replace("length / 12", "length / 99");
  writeFileSync(file, changed);
  const refs = toolReferences(dir);
  assert.ok(refs[0]!.text.includes("length / 99"));
  assert.equal(refs[0]!.provenance.fileHash, hash(changed));
  assert.equal(
    refs[0]!.provenance.excerptHash,
    hash(changed.slice(refs[0]!.provenance.start, refs[0]!.provenance.end)),
  );
  writeFileSync(
    file,
    changed.replace("        profile_score: {", "        renamed_score: {"),
  );
  assert.throws(() => toolReferences(dir), /boundaries/);
});
test("calibration controls are reproducible, isolated from judge requests and distinguish malformed/missing judgments", async () => {
  const materials = calibrationMaterials(ROOT),
    { bundle, controlFile } = materials;
  assert.deepEqual(materials, calibrationMaterials(ROOT));
  assert.equal(bundle.cases.length, 14);
  for (const job of reviewSchedule(bundle)) {
    const request = reviewRequest(
      bundle.cases.find((c) => c.id === job.caseId)!,
      job,
    );
    const serialized = JSON.stringify(request);
    for (const label of controlFile.controls) {
      assert.ok(!serialized.includes(label.name));
      assert.ok(!serialized.includes(label.reason));
    }
  }
  const runner = new BlindRunner(":memory:");
  try {
    const result = await runner.execute(bundle, blindProvider(), {
      ...config(),
      maxCalls: 100,
      maxInputTokens: 1000000,
      maxOutputTokens: 100000,
      model: "blind-fixture",
    });
    assert.equal(result.valid, 84);
    const analysis = analyzeCalibration(controlFile, bundle, result.rows);
    assert.equal(analysis.cases, 14);
    assert.equal(analysis.completeCases, 14);
    assert.equal(analysis.allChecksPassed, 0); // Deliberately all scores 3 / ties fail these controls.
    const duplicate = structuredClone(result.rows);
    duplicate[1] = duplicate[0]!;
    assert.throws(
      () => analyzeCalibration(controlFile, bundle, duplicate),
      /duplicated/,
    );
    const tampered = structuredClone(result.rows);
    (tampered[0]!.result!.judgment as any).dimensions[0].score = 0;
    assert.throws(
      () => analyzeCalibration(controlFile, bundle, tampered),
      /raw response/,
    );
    const missing = structuredClone(result.rows);
    missing[0]!.result = null;
    assert.equal(
      analyzeCalibration(controlFile, bundle, missing).completeCases,
      13,
    );
  } finally {
    runner.close();
  }
});
