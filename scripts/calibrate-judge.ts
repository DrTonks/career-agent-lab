import { parseArgs } from "node:util";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  calibrationMaterials,
  analyzeCalibration,
} from "../src/judge-calibration.js";
import { readJson } from "../src/config.js";
import { validateBundle } from "../src/blind-review.js";
const { values: v } = parseArgs({
  options: {
    snapshot: { type: "string" },
    out: { type: "string" },
    controls: { type: "string" },
    bundle: { type: "string" },
    result: { type: "string" },
  },
});
if (!v.out) throw Error("--out required");
if (v.snapshot) {
  const materials = calibrationMaterials(resolve(v.snapshot));
  mkdirSync(resolve(v.out), { recursive: false });
  for (const [name, data] of Object.entries({
    "bundle.json": materials.bundle,
    "controls.private.json": materials.controlFile,
    "provenance.json": materials.provenance,
  }))
    writeFileSync(resolve(v.out, name), JSON.stringify(data, null, 2), {
      flag: "wx",
    });
  console.log(
    JSON.stringify({
      cases: materials.bundle.cases.length,
      bundleHash: materials.controlFile.bundleHash,
    }),
  );
} else {
  if (!v.controls || !v.bundle || !v.result)
    throw Error(
      "--controls FILE --bundle FILE --result FILE required for analysis",
    );
  const summary = analyzeCalibration(
    readJson(v.controls),
    validateBundle(readJson(v.bundle)),
    readJson<{ rows: any[] }>(v.result).rows,
  );
  writeFileSync(resolve(v.out), JSON.stringify(summary, null, 2), {
    flag: "wx",
  });
  console.log(
    JSON.stringify({
      cases: summary.cases,
      complete: summary.completeCases,
      passed: summary.allChecksPassed,
    }),
  );
}
