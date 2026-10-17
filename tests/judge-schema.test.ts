import test from "node:test";
import assert from "node:assert/strict";
import { hash } from "../src/config.js";
import {
  judgmentSchema,
  reviewSchedule,
  reviewRequest,
} from "../src/blind-review.js";
import { citationCatalog } from "../src/review-submission.js";
import { blindBundle } from "./fixtures/blind-provider.js";

test("judge wire schema permits shared/owned fragments and excludes the opposite candidate in each branch", () => {
  const bundle = structuredClone(blindBundle);
  for (const label of ["A", "B"] as const)
    bundle.cases[0]!.sources.push({
      id: `memory:${label}`,
      kind: "memory-context",
      candidate: label,
      text: `owned-${label}`,
      sha256: hash(`owned-${label}`),
    });
  const c = bundle.cases[0]!;
  const owned = Object.fromEntries(
    ["A", "B"].map((label) => [
      label,
      citationCatalog(c.sources.filter((s) => s.candidate === label))[0]!.id,
    ]),
  );
  for (const job of reviewSchedule(bundle)) {
    const schema = judgmentSchema(c, job) as any;
    const wire = reviewRequest(c, job).tools[0]!.function.parameters;
    assert.deepEqual(wire, schema);
    for (const label of job.labels) {
      const ids = schema.$defs[`source_${label}`].enum;
      assert.ok(ids.includes(owned[label]));
      assert.ok(!ids.includes(owned[label === "A" ? "B" : "A"]));
      const answerIds = citationCatalog([
        {
          id: `answer:${label}`,
          kind: "answer",
          text: c.candidates.find((x) => x.label === label)!.text,
        },
      ]).map((x) => x.id);
      assert.deepEqual(schema.$defs[`answer_${label}`].enum, answerIds);
      const basis =
        job.kind === "rating"
          ? schema.properties.dimensions.items
          : schema.properties.reasons.items.anyOf.find(
              (x: any) => x.properties.label.enum[0] === label,
            );
      assert.equal(
        basis.properties.evidenceIds.items.$ref,
        `#/$defs/source_${label}`,
      );
      assert.equal(
        basis.properties.answerEvidenceIds.items.$ref,
        `#/$defs/answer_${label}`,
      );
      assert.ok(basis.required.includes("evidenceIds"));
      assert.ok(basis.required.includes("answerEvidenceIds"));
      assert.equal(basis.additionalProperties, false);
    }
    if (job.kind === "rating") {
      assert.deepEqual(schema.properties.label.enum, job.labels);
      assert.equal(Object.keys(schema.$defs).length, 2);
    }
  }
});

test("empty answer has no invented fragment requirement and invalid jobs cannot produce an ambiguous schema", () => {
  const bundle = structuredClone(blindBundle);
  bundle.cases[0]!.candidates[0]!.text = "";
  const c = bundle.cases[0]!,
    job = reviewSchedule(bundle).find(
      (j) => j.kind === "rating" && j.labels[0] === "A",
    )!;
  const schema = judgmentSchema(c, job) as any;
  assert.equal(
    schema.properties.dimensions.items.properties.answerEvidenceIds.minItems,
    0,
  );
  assert.equal(
    schema.properties.dimensions.items.properties.answerEvidenceIds.maxItems,
    0,
  );
  assert.equal(schema.$defs.answer_A, undefined);
  assert.throws(
    () => judgmentSchema(c, { ...job, labels: ["A", "B"] }),
    /one candidate/,
  );
  assert.throws(
    () => judgmentSchema(c, { ...job, kind: "comparison", labels: ["A", "A"] }),
    /both candidates/,
  );
});
