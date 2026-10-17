import test from "node:test";
import assert from "node:assert/strict";
import {
  allowsEvidenceStatusClassification,
  AssertionAudit,
  inspectAssertions,
  reviewUnits,
} from "../src/assertion-review.js";

test("bounded negated inference with a personal pronoun remains an evidence-state candidate", () => {
  for (const text of [
    "证据缺失是未知，不代表你没有相应能力。",
    "材料不足不意味着您没有实习经历。",
    "这不表示用户不会Python。",
    "上述结果不等于该学生没有能力。",
    "不能说明你没有能力，也不代表你没有实习。",
    "材料完整度为零，不代表你能力为零。",
    "证据不足以外的情况待核验；不代表你没有证书。",
  ])
    assert(allowsEvidenceStatusClassification(text), text);
});

test("negated inference cannot hide double negation or an independent personal assertion", () => {
  for (const text of [
    "并非不代表你没有相应能力。",
    "不是不意味着你没有能力。",
    "不代表你没有能力，但你没有企业实习经历。",
    "不代表你没有能力且你已取得证书。",
    "这不意味着你不会Python，同时你熟练使用Java。",
    "不代表你没有能力\n你有企业实习经历。",
    "不代表你没有能力！你已取得证书。",
    "你具备Python能力，这不代表你没有其他能力。",
    "不代表你没有能力你有企业实习经历。",
    "不代表你没有能力，所以没有专业能力。",
  ])
    assert(!allowsEvidenceStatusClassification(text), text);
});

test("allowing the classification never substitutes for evidence or supports a verdict", () => {
  const text = "材料不足，不代表你没有相应能力。";
  const audit = AssertionAudit.parse({
    units: reviewUnits(text).map((u) => ({
      unitIds: [u.id],
      kind: "evidence_status",
      verdict: "supported",
      citations: [],
      reason: "仅否定推断，仍需核对实际材料状态",
    })),
    changes: [],
    hardConditionCounts: [],
  });
  assert.throws(
    () => inspectAssertions(text, audit, [], 0),
    /requires an exact source/,
  );
  audit.units.forEach((u) => {
    u.verdict = "nonfactual";
  });
  assert(
    inspectAssertions(text, audit, [], 0).some((p) =>
      p.includes("cannot bypass"),
    ),
  );
});
