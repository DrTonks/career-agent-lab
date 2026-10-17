import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { hash, readJson } from "../src/config.js";
import { ComparisonSuite, type ComparisonPlan } from "../src/comparison.js";
import { validateBundle } from "../src/blind-review.js";
import { blindCommonSources } from "../src/blind-materials.js";
import { loadDataset } from "../src/data.js";
import {
  humanPacket,
  analyzeHuman,
  type HumanCard,
  type HumanMapping,
  type HumanPacket,
} from "../src/human-review.js";
import { humanReviewPage } from "../src/human-review-page.js";
const { values: v } = parseArgs({
  options: {
    experiment: { type: "string" },
    materials: { type: "string" },
    out: { type: "string" },
    packet: { type: "string" },
    mapping: { type: "string" },
    scores: { type: "string" },
    "confirm-public-synthetic": { type: "boolean" },
  },
});
if (!v.out) throw Error("--out required; never overwrite existing outputs");
const save = (path: string, value: unknown) =>
  writeFileSync(path, JSON.stringify(value, null, 2), { flag: "wx" });
if (v.scores) {
  if (!v.packet || !v.mapping) throw Error("--packet and --mapping required");
  const result = analyzeHuman(
    readJson<HumanPacket>(resolve(v.packet)),
    readJson<HumanMapping>(resolve(v.mapping)),
    readJson(resolve(v.scores)),
  );
  save(resolve(v.out), result);
  console.log(
    JSON.stringify({
      output: resolve(v.out),
      planned: result.plannedCards,
      completed: result.completed,
      pending: result.pending,
    }),
  );
} else {
  if (!v.experiment || !v.materials || !v["confirm-public-synthetic"])
    throw Error("--experiment --materials --confirm-public-synthetic required");
  const root = resolve(v.experiment),
    materials = resolve(v.materials),
    out = resolve(v.out);
  if (existsSync(out)) throw Error("Output exists");
  const plan = readJson<ComparisonPlan>(resolve(root, "plan.json"));
  const { hash: planHash, ...planBody } = plan;
  if (hash(planBody) !== planHash) throw Error("Frozen plan hash mismatch");
  const suite = ComparisonSuite.parse(plan.suite),
    salt = randomBytes(24).toString("hex");
  const cards: HumanCard[] = [],
    entries: HumanMapping["entries"] = [],
    provenance: any[] = [];
  const digest = (p: string) =>
    createHash("sha256").update(readFileSync(p)).digest("hex");
  for (const scenario of suite.cases) {
    const pair = resolve(root, "pairs", scenario.id + "-r0"),
      records = readJson<any[]>(resolve(pair, "records.json"));
    const data = loadDataset(resolve(pair, "snapshot/dataset.json"));
    if (data.source !== "synthetic") throw Error("Non-synthetic data");
    const common = blindCommonSources(pair, data);
    const materialDir = resolve(
      materials,
      "materials",
      scenario.id + "-delivered",
    );
    const bundle = existsSync(resolve(materialDir, "bundle.json"))
      ? validateBundle(readJson(resolve(materialDir, "bundle.json")))
      : null;
    const mapping = bundle
      ? readJson<any[]>(resolve(materialDir, "mapping.private.json"))
      : [];
    const db = new DatabaseSync(resolve(pair, "runs.sqlite"), {
      readOnly: true,
    });
    try {
      const stored = db
        .prepare("SELECT body FROM runs")
        .all()
        .map((r) => JSON.parse(String(r.body)));
      if (
        stored.length !== records.length ||
        new Set(records.map((r) => r.runId)).size !== records.length
      )
        throw Error("Record coverage mismatch");
      for (const architecture of ["multi-agent", "skills"] as const) {
        const selected = records
          .filter((r) => r.architecture === architecture)
          .sort((a, b) => a.turn - b.turn);
        if (
          selected.some(
            (r, i) =>
              r.caseId !== scenario.id || r.repeat !== 0 || r.turn !== i + 1,
          ) ||
          selected.length > scenario.replies.length + 1
        )
          throw Error("Non-prefix or foreign records");
        const id = hash([salt, scenario.id, architecture]).slice(0, 16),
          turns: HumanCard["turns"] = [];
        for (let turn = 1; turn <= scenario.replies.length + 1; turn++) {
          const row = selected.find((r) => r.turn === turn);
          if (!row) {
            const planned: any =
              turn === 1 ? scenario.first : scenario.replies[turn - 2];
            turns.push({
              turn,
              executed: false,
              request: JSON.stringify(
                planned,
                (k, val) =>
                  [
                    "userId",
                    "conversationId",
                    "architecture",
                    "operationId",
                  ].includes(k)
                    ? undefined
                    : val,
                2,
              ),
              resumeText: "",
              constraints: null,
              answer: null,
              status: "not-executed",
              sourceCoverage: "仅计划输入；未执行，无证据回执。",
              sources: [],
            });
            continue;
          }
          const run = stored.find((r) => r.id === row.runId),
            file = readJson<any>(resolve(pair, row.runId + ".request.json"));
          if (
            !run ||
            run.mode !== "live" ||
            run.request.architecture !== architecture ||
            run.datasetVersion !== data.version ||
            run.status !== row.status ||
            (run.answer ?? "") !== row.answer ||
            ["created", "running", "waiting_approval"].includes(run.status) ||
            hash(file.request) !== hash(run.request) ||
            hash(file.continuation) !== hash(run.continuation ?? null)
          )
            throw Error("Run provenance mismatch");
          const mapped = mapping.find((m) => m.runId === run.id),
            c = mapped
              ? bundle!.cases.find((c) => c.id === mapped.caseId)
              : null;
          if (
            bundle &&
            (!c ||
              mapped.architecture !== architecture ||
              mapped.track !== "delivered" ||
              c.candidates.find((x) => x.label === mapped.label)?.text !==
                row.answer ||
              mapped.originalAnswerHash !== hash(row.answer))
          )
            throw Error("Material/answer mismatch");
          const sources = c
            ? c.sources.filter(
                (s) => !s.candidate || s.candidate === mapped.label,
              )
            : common;
          turns.push({
            turn,
            executed: true,
            request: run.request.request,
            resumeText: run.request.resumeText,
            constraints: run.request.constraints,
            answer: row.answer,
            status: row.status,
            sourceCoverage: c
              ? "候选专属、截至当前轮的已导出来源；无另一候选来源。"
              : "会话配对未完成：仅公共规则/数据和原始请求；工具及记忆附件不足，无法核实的事实请记未评并说明。",
            sources: sources.map((s, i) => ({
              id: `T${turn}:S${i + 1}`,
              kind: s.kind,
              text: s.text,
              sha256: hash(s.text),
            })),
          });
          provenance.push({
            cardId: id,
            turn,
            runId: run.id,
            requestHash: digest(resolve(pair, row.runId + ".request.json")),
            answerHash: hash(row.answer),
            bundleHash: bundle ? hash(bundle) : null,
            sourceIds: sources.map((s, i) => ({
              id: `T${turn}:S${i + 1}`,
              originalId: s.id,
            })),
          });
        }
        cards.push({ id, turns });
        entries.push({
          cardId: id,
          caseId: scenario.id,
          architecture,
          stratum: scenario.stratum,
        });
      }
    } finally {
      db.close();
    }
  }
  cards.sort((a, b) =>
    hash([salt, "order", a.id]).localeCompare(hash([salt, "order", b.id])),
  );
  const packet = humanPacket(cards, entries);
  mkdirSync(out);
  mkdirSync(resolve(out, "reviewer"));
  mkdirSync(resolve(out, "organizer"));
  save(resolve(out, "reviewer/packet.json"), packet);
  writeFileSync(resolve(out, "reviewer/review.html"), humanReviewPage(packet), {
    flag: "wx",
  });
  save(resolve(out, "organizer/mapping.private.json"), {
    packetDigest: packet.digest,
    entries,
  });
  save(resolve(out, "organizer/provenance.json"), {
    createdAt: new Date().toISOString(),
    planHash,
    repeat: 0,
    salt,
    provenance,
    limitations: [
      "Original answer self-descriptions may reveal architecture; no claim of perfect blinding.",
      "Incomplete conversation includes all planned turns; no invented answer or silently excluded failure.",
      "Only organizer sees architecture mapping. No AI scores in reviewer materials.",
    ],
  });
  save(resolve(out, "reviewer/blank-scores.json"), {
    version: "human-scores-v1",
    packetDigest: packet.digest,
    reviewerId: "",
    ratings: [],
  });
  console.log(
    JSON.stringify({
      output: out,
      cards: cards.length,
      plannedTurns: cards.reduce((s, c) => s + c.turns.length, 0),
      observedTurns: cards.flatMap((c) => c.turns).filter((t) => t.executed)
        .length,
      packetDigest: packet.digest,
    }),
  );
}
