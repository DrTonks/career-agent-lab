import { DatabaseSync } from "node:sqlite";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { z } from "zod";
import {
  Category,
  Dataset,
  Edge,
  Job,
  KnowledgeDoc,
  Roles,
} from "./contracts.js";
import { hash, readJson } from "./config.js";

export const clean = (s: unknown) =>
  String(s ?? "")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .trim();
export function salary(text: string): [number | null, number | null] {
  if (/天|日|小时|时薪|年薪|\/年|面议/.test(text)) return [null, null];
  const m = text
    .toLowerCase()
    .match(
      /(\d+(?:\.\d+)?)\s*(万|千|k)?\s*[-~至]\s*(\d+(?:\.\d+)?)\s*(万|千|k|元)?/,
    );
  if (!m) return [null, null];
  const factor = (u?: string) =>
    u === "万" ? 10000 : ["千", "k"].includes(u ?? "") ? 1000 : 1;
  return [
    Number(m[1]) * factor(m[2] ?? m[4]),
    Number(m[3]) * factor(m[4] ?? m[2]),
  ];
}
export function educationRank(text: string): number | null {
  if (/不限|无要求/.test(text)) return 0;
  const values = ["高中", "大专", "本科", "硕士", "博士"];
  const index = values.findIndex((v) => text.includes(v));
  return index < 0 ? null : index + 1;
}
export function experience(text: string): number | null {
  if (/不限|应届|无经验|经验不/.test(text)) return 0;
  const m = text.match(/(\d+)\s*(?:[-至]\s*\d+)?\s*年/);
  return m ? Number(m[1]) : null;
}
export function weekend(text: string): boolean | null {
  const yes = /双休|周末双休|周末休息/.test(text.replace(/非双休|不双休/g, "")),
    no = /单休|大小周|非双休|不双休/.test(text);
  return yes && !no ? true : no && !yes ? false : null;
}
export function extractRequirements(jd: string) {
  const educationSpan =
    jd.match(
      /(?:高中|大专|本科|硕士|博士)(?:及以上|以上)?(?:学历|学位)|(?:高中|大专|本科|硕士|博士)及以上|学历不限/,
    )?.[0] ?? "";
  const experienceSpan =
    jd.match(
      /\d+\s*(?:[-至~]\s*\d+)?\s*年(?:以上|及以上)?(?:相关|开发|行业|工作|项目|测试|实习)?(?:工作)?经验|(?:经验不限|应届毕业生|接受应届生|无工作经验要求)/,
    )?.[0] ?? "";
  return {
    educationRank: educationRank(educationSpan),
    experienceMin: experience(experienceSpan),
    educationSpan,
    experienceSpan,
  };
}
const datasetShape = z.object({
  version: z.string(),
  label: z.string(),
  source: z.enum(["synthetic", "private"]),
  jobs: z.array(Job),
  categories: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      family: z.string(),
      level: z.string(),
      summary: z.string(),
      skills: z.array(z.string()),
      abilities: z.record(z.string(), z.number()),
    }),
  ),
  edges: z.array(
    z.object({
      source: z.string(),
      target: z.string(),
      type: z.enum(["promotion", "transfer"]),
      score: z.number(),
      reason: z.string(),
    }),
  ),
  documents: z.array(
    z.object({
      id: z.string(),
      text: z.string(),
      sourceId: z.string(),
      kind: z.enum(["resume", "job", "category", "graph", "rule", "artifact"]),
      roles: z.array(z.enum(Roles)),
      categoryId: z.string().optional(),
    }),
  ),
});
export function validateDataset(value: unknown): Dataset {
  const d = datasetShape.parse(value);
  const unique = (ids: string[], label: string) => {
    if (new Set(ids).size !== ids.length)
      throw new Error(`Duplicate ${label} ID`);
  };
  unique(
    d.jobs.map((j) => j.id),
    "job",
  );
  unique(
    d.categories.map((c) => c.id),
    "category",
  );
  unique(
    d.documents.map((c) => c.id),
    "document",
  );
  const cats = new Set(d.categories.map((c) => c.id));
  if (
    d.jobs.some((j) => j.categoryId && !cats.has(j.categoryId)) ||
    d.edges.some((e) => !cats.has(e.source) || !cats.has(e.target))
  )
    throw new Error("Dangling category/edge reference");
  return d;
}
export function loadDataset(path: string): Dataset {
  return validateDataset(readJson(path));
}
export function writeDataset(path: string, d: Dataset) {
  validateDataset(d);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(d, null, 2));
}
export function importLegacy(root: string, output: string, bundle: string) {
  const read = (p: string) => readJson<Record<string, any>>(resolve(root, p));
  const rawJobs = read("aiData/jobs_norm.json").jobs as Record<string, any>[];
  const byId = new Map<string, Map<string, Record<string, any>>>();
  for (const job of rawJobs) {
    const variants = byId.get(String(job.id)) ?? new Map();
    variants.set(hash(job), job);
    byId.set(String(job.id), variants);
  }
  const conflicts = [...byId.entries()].filter(
    ([, variants]) => variants.size > 1,
  );
  // Conflicting IDs are quarantined instead of arbitrarily preferring a salary/qualification.
  const originalJobs = [...byId.values()]
    .filter((variants) => variants.size === 1)
    .map((variants) => [...variants.values()][0]!);
  const canonical = read("newData/step2/canonical_jobs_filtered.json")
    .canonicalJobs as Record<string, any>[];
  const profiles = read("newData/step3/job_profiles_v2.json")
    .profiles as Record<string, any>[];
  const categories: Category[] = profiles.map((p) => ({
    id: p.canonicalJobId,
    title: p.jobName,
    family: p.jobFamily,
    level: String(p.level),
    summary: clean(p.summary),
    skills: [
      ...new Set<string>([
        ...(p.skills?.coreSkills ?? []),
        ...(p.skills?.hardSkills ?? []),
      ]),
    ],
    abilities: p.abilityRequirements ?? {},
  }));
  const sampled = new Map<string, Set<string>>();
  for (const c of canonical)
    for (const jd of c.sampledJDs ?? []) {
      const s = sampled.get(jd.id) ?? new Set<string>();
      s.add(c.canonicalJobId);
      sampled.set(jd.id, s);
    }
  const methods = { sample: 0, familyLevel: 0, unmapped: 0, ambiguous: 0 };
  const jobs: Job[] = originalJobs.map((j) => {
    const candidates = [...(sampled.get(j.id) ?? [])];
    let categoryId: string | null = null;
    if (candidates.length === 1) {
      categoryId = candidates[0]!;
      methods.sample++;
    } else if (candidates.length > 1) {
      methods.ambiguous++;
      methods.unmapped++;
    } else {
      const same = categories.filter(
        (c) => c.family === j.job_family && c.level === String(j.level),
      );
      if (same.length === 1) {
        categoryId = same[0]!.id;
        methods.familyLevel++;
      } else methods.unmapped++;
    }
    const [salaryMin, salaryMax] = salary(String(j.salary ?? ""));
    const jd = clean(j.jd_text);
    const extracted = extractRequirements(jd);
    // Skills are observed in this JD, never inherited wholesale from its category.
    const vocab = categoryId
      ? categories.find((c) => c.id === categoryId)!.skills
      : [];
    return {
      id: String(j.id),
      title: clean(j.job_name),
      city: clean(j.city).split(/[-·]/)[0]!.replace(/市$/, ""),
      categoryId,
      family: clean(j.job_family),
      level: String(j.level ?? ""),
      jd,
      company: clean(j.company),
      source: clean(j.source_url),
      updatedAt: clean(j.updated_at),
      salaryMin,
      salaryMax,
      educationRank:
        educationRank(clean(j.education)) ?? extracted.educationRank,
      experienceMin: experience(clean(j.experience)) ?? extracted.experienceMin,
      weekendsOff: weekend(jd),
      skills: vocab.filter((s) => jd.toLowerCase().includes(s.toLowerCase())),
      raw: {
        educationSource: clean(j.education) || extracted.educationSpan,
        experienceSource: clean(j.experience) || extracted.experienceSpan,
        salarySource: clean(j.salary),
      },
    };
  });
  const db = new DatabaseSync(resolve(bundle, "career_kb.sqlite"), {
    readOnly: true,
  });
  const edges: Edge[] = [];
  try {
    for (const [table, type] of [
      ["promotion_edges", "promotion"],
      ["transfer_edges", "transfer"],
    ] as const)
      for (const e of db.prepare(`SELECT * FROM ${table}`).all())
        edges.push({
          source: String(e.sourceJobId),
          target: String(e.targetJobId),
          type,
          score: Number(e.score),
          reason: String(e.reason),
        });
  } finally {
    db.close();
  }
  const docs = readFileSync(resolve(bundle, "kb_chunks.jsonl"), "utf8")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((s) => JSON.parse(s));
  const documents: KnowledgeDoc[] = docs.map((d) => ({
    id: d.chunkId,
    text: d.text,
    sourceId: d.docId,
    kind: d.docType === "job_profile" ? "category" : "graph",
    roles: d.docType === "job_profile" ? ["match", "path"] : ["path"],
    ...(d.metadata?.canonicalJobId
      ? { categoryId: d.metadata.canonicalJobId }
      : {}),
  }));
  const content = { jobs, categories, edges, documents };
  const dataset: Dataset = {
    version: hash(content),
    label: "Local legacy snapshot (not current vacancies)",
    source: "private",
    ...content,
  };
  writeDataset(output, dataset);
  const report = {
    version: dataset.version,
    rawRows: rawJobs.length,
    uniqueSourceIds: byId.size,
    exactDuplicateRows:
      rawJobs.length - [...byId.values()].reduce((s, v) => s + v.size, 0),
    quarantinedIds: conflicts.length,
    jobs: jobs.length,
    categories: categories.length,
    edges: edges.length,
    chunks: documents.length,
    mapping: methods,
    coverage: jobs.filter((j) => j.categoryId).length / jobs.length,
    unknown: {
      salary: jobs.filter((j) => j.salaryMin === null).length,
      education: jobs.filter((j) => j.educationRank === null).length,
      experience: jobs.filter((j) => j.experienceMin === null).length,
      weekends: jobs.filter((j) => j.weekendsOff === null).length,
    },
    embedding:
      "Existing category/path embeddings not automatically attached: verify model/query preprocessing, or rebuild index.",
    licensing: "Private local input. Redistribution not assumed.",
  };
  writeFileSync(
    output.replace(/\.json$/, ".quarantine.json"),
    JSON.stringify(
      conflicts.map(([id, variants]) => ({
        id,
        variants: [...variants.values()],
      })),
      null,
      2,
    ),
  );
  writeFileSync(
    output.replace(/\.json$/, ".audit.json"),
    JSON.stringify(report, null, 2),
  );
  return report;
}
