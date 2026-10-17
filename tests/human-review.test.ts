import test from "node:test";
import assert from "node:assert/strict";
import { Script } from "node:vm";
import { dimensions } from "../src/blind-review.js";
import { hash } from "../src/config.js";
import {
  humanPacket,
  analyzeHuman,
  validateHumanSubmission,
  type HumanMapping,
} from "../src/human-review.js";
import { humanReviewPage } from "../src/human-review-page.js";
function fixture() {
  const entries: HumanMapping["entries"] = Array.from(
    { length: 4 },
    (_, i) => ({
      cardId: "card" + i,
      caseId: "case" + Math.floor(i / 2),
      architecture: i % 2 ? "skills" : "multi-agent",
      stratum: "single-domain",
    }),
  );
  const text = "</script><script>globalThis.bad=true</script>";
  const packet = humanPacket(
    entries.map((e) => ({
      id: e.cardId,
      turns: [
        {
          turn: 1,
          executed: true,
          request: "task",
          resumeText: "",
          constraints: {},
          answer: text,
          status: "partial",
          sourceCoverage: "fixture",
          sources: [{ id: "s1", kind: "request", text, sha256: hash(text) }],
        },
      ],
    })),
    entries,
  );
  const input = {
    version: "human-scores-v1",
    packetDigest: packet.digest,
    reviewerId: "reviewer-test",
    ratings: entries.map((e, i) => ({
      cardId: e.cardId,
      status: "completed",
      scores: Object.fromEntries(dimensions.map((d) => [d, i % 2 ? 2 : 3])),
      note: "source s1 supports rating",
      issues: [],
    })),
  };
  return { packet, mapping: { packetDigest: packet.digest, entries }, input };
}
test("human scoring validates packet identity, mapping commitment and duplicate submissions", () => {
  const { packet, mapping, input } = fixture();
  assert.equal(validateHumanSubmission(packet, input).ratings.length, 4);
  assert.throws(
    () => validateHumanSubmission(packet, { ...input, packetDigest: "other" }),
    /Wrong packet/,
  );
  assert.throws(
    () =>
      validateHumanSubmission(packet, {
        ...input,
        ratings: [...input.ratings, input.ratings[0]],
      }),
    /Duplicate/,
  );
  const changed = structuredClone(packet);
  changed.cards[0]!.turns[0]!.answer = "changed";
  assert.throws(
    () => validateHumanSubmission(changed, input),
    /Packet changed/,
  );
  const wrong = structuredClone(mapping);
  wrong.entries[0]!.architecture = "skills";
  assert.throws(() => analyzeHuman(packet, wrong, input), /Mapping mismatch/);
});
test("paired conversation analysis preserves missing dimensions, partial submissions and critical issues", () => {
  const { packet, mapping, input } = fixture();
  const all = analyzeHuman(packet, mapping, input);
  assert.equal(all.overall.factualSupport!.pairs, 2);
  assert.equal(all.overall.factualSupport!.multiMinusSkills, 1);
  assert.deepEqual(all.overall.factualSupport!.percentile95, [1, 1]);
  const partial: any = structuredClone(input);
  partial.ratings.pop();
  partial.ratings[0].scores.factualSupport = null;
  partial.ratings[0].issues = [
    {
      turn: 1,
      severity: "critical",
      evidence: "answer sentence",
      reason: "contradiction",
    },
  ];
  const result = analyzeHuman(packet, mapping, partial);
  assert.equal(result.pending, 1);
  assert.equal(result.overall.factualSupport!.pairs, 0);
  assert.equal(result.overall.hardConstraints!.pairs, 1);
  assert.equal(result.overall.meanDelta!.pairs, 0);
  assert.equal(result.criticalIssues.length, 1);
});
test("unassessed is not zero and nonexecuted turns cannot acquire fabricated answers", () => {
  const { packet, input } = fixture();
  const x: any = structuredClone(input);
  x.ratings[0].status = "unassessed";
  assert.throws(() => validateHumanSubmission(packet, x), /Unassessed/);
  const bad = structuredClone(packet.cards);
  bad[0]!.turns[0]!.executed = false;
  assert.throws(() => humanPacket(bad, []), /coverage/);
  x.ratings[0].status = "completed";
  x.ratings[0].scores.consistency = 5;
  assert.throws(() => validateHumanSubmission(packet, x));
  x.ratings[0].scores.consistency = 3;
  x.ratings[0].issues = [
    { turn: 2, severity: "critical", evidence: "x", reason: "x" },
  ];
  assert.throws(() => validateHumanSubmission(packet, x), /outside/);
});
test("offline review page safely embeds hostile source text and its browser script parses", () => {
  const { packet } = fixture();
  const page = humanReviewPage(packet);
  assert.ok(!page.includes("<script>globalThis.bad"));
  assert.ok(!page.includes("innerHTML"));
  const embedded = page.match(
    /<script id="packet" type="application\/json">([\s\S]*?)<\/script>/,
  )![1]!;
  assert.deepEqual(JSON.parse(embedded), packet);
  const script = page.match(/<\/script><script>([\s\S]*?)<\/script>/)![1]!;
  assert.doesNotThrow(() => new Script(script));
});
