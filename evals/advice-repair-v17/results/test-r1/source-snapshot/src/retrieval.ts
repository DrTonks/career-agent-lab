import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  Constraints,
  Dataset,
  Evidence,
  Job,
  KnowledgeDoc,
  Role,
} from "./contracts.js";
import { educationRank } from "./data.js";
import { hash, ROOT } from "./config.js";
export function tokenize(text: string): string[] {
  const s = text.toLowerCase().normalize("NFKC");
  const out: string[] = s.match(/[a-z][a-z0-9+#.-]*|\d+/g) ?? [];
  for (const block of s.match(/[\u3400-\u9fff]+/g) ?? []) {
    if (block.length === 1) out.push(block);
    else
      for (let i = 0; i < block.length - 1; i++)
        out.push(block.slice(i, i + 2));
  }
  return out;
}
export class BM25 {
  private tokens: Map<string, number>[];
  private lengths: number[];
  private df = new Map<string, number>();
  private avg: number;
  constructor(private texts: string[]) {
    this.tokens = texts.map((t) => {
      const m = new Map<string, number>();
      for (const x of tokenize(t)) m.set(x, (m.get(x) ?? 0) + 1);
      for (const x of m.keys()) this.df.set(x, (this.df.get(x) ?? 0) + 1);
      return m;
    });
    this.lengths = this.tokens.map((m) =>
      [...m.values()].reduce((a, b) => a + b, 0),
    );
    this.avg =
      this.lengths.reduce((a, b) => a + b, 0) / (texts.length || 1) || 1;
  }
  rank(query: string, allowed: number[], limit: number) {
    const terms = [...new Set(tokenize(query))];
    return allowed
      .map((i) => ({
        i,
        score: terms.reduce((s, t) => {
          const tf = this.tokens[i]?.get(t) ?? 0,
            df = this.df.get(t) ?? 0;
          return (
            s +
            (Math.log(1 + (this.texts.length - df + 0.5) / (df + 0.5)) *
              tf *
              2.2) /
              (tf + 1.2 * (0.25 + (0.75 * (this.lengths[i] ?? 0)) / this.avg))
          );
        }, 0),
      }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || a.i - b.i)
      .slice(0, limit);
  }
}
export function jobConstraintCheck(job: Job, c: Constraints) {
  const violations: string[] = [],
    unknowns: string[] = [];
  if (c.cities.length) {
    if (!job.city.trim()) unknowns.push("city");
    else if (
      !c.cities
        .map((x) => x.replace(/市$/, ""))
        .includes(job.city.replace(/市$/, ""))
    )
      violations.push("city");
  }
  if (c.minMonthlySalary !== undefined) {
    if (job.salaryMin === null) unknowns.push("salary");
    else if (job.salaryMin < c.minMonthlySalary) violations.push("salary");
  }
  if (c.education !== undefined && c.education !== "不限") {
    const rank = educationRank(c.education);
    if (job.educationRank === null) unknowns.push("education");
    else if (rank !== null && job.educationRank > rank)
      violations.push("education");
  }
  if (c.experienceYears !== undefined) {
    if (job.experienceMin === null) unknowns.push("experience");
    else if (job.experienceMin > c.experienceYears)
      violations.push("experience");
  }
  if (c.weekendsOff !== undefined) {
    if (job.weekendsOff === null) unknowns.push("weekendsOff");
    else if (job.weekendsOff !== c.weekendsOff) violations.push("weekendsOff");
  }
  return {
    eligible: !violations.length && !unknowns.length,
    violations,
    unknowns,
    checks: Object.entries({
      city: {
        requested: c.cities.length ? c.cities : null,
        observed: job.city.trim() || null,
      },
      salary: {
        requested: c.minMonthlySalary ?? null,
        observed: job.salaryMin,
      },
      education: {
        requested: c.education && c.education !== "不限" ? c.education : null,
        observed: job.educationRank,
      },
      experience: {
        requested: c.experienceYears ?? null,
        observed: job.experienceMin,
      },
      weekendsOff: {
        requested: c.weekendsOff ?? null,
        observed: job.weekendsOff,
      },
    }).map(([field, values]) => ({
      field,
      ...values,
      status:
        values.requested === null
          ? "not_requested"
          : violations.includes(field)
            ? "violated"
            : unknowns.includes(field)
              ? "unknown"
              : "satisfied",
    })),
    scope:
      "Only explicitly requested hard conditions are checked. not_requested is not satisfied. Eligibility is not a guarantee of suitability, recruitment or an offer.",
  };
}
export interface VectorSearch {
  mode: string;
  fingerprint: string;
  rank(
    query: string,
    ids: string[],
    signal: AbortSignal,
  ): Promise<
    Array<{
      id: string;
      score: number;
      passage?: { start: number; end: number; chunkId: string };
    }>
  >;
}
export class Knowledge {
  readonly docs: KnowledgeDoc[];
  private index: BM25;
  readonly snapshotHash: string;
  readonly executionHash: string;
  constructor(
    readonly data: Dataset,
    readonly vectors?: VectorSearch,
  ) {
    const rules: KnowledgeDoc[] = (
      ["profile", "match", "path", "report"] as Role[]
    ).map((role) => ({
      id: `rule:${role}`,
      sourceId: `knowledge/${role}.md`,
      kind: "rule",
      roles: [role],
      text: readFileSync(resolve(ROOT, `knowledge/${role}.md`), "utf8"),
    }));
    this.docs = [
      ...data.documents,
      ...data.jobs.map((j) => ({
        id: `job:${j.id}`,
        sourceId: j.id,
        kind: "job" as const,
        roles: ["match", "path"] as Role[],
        categoryId: j.categoryId ?? undefined,
        text: JSON.stringify(j),
      })),
      ...data.categories.map((c) => ({
        id: `category:${c.id}`,
        sourceId: c.id,
        kind: "category" as const,
        roles: ["match", "path"] as Role[],
        categoryId: c.id,
        text: JSON.stringify(c),
      })),
      ...rules,
    ];
    if (new Set(this.docs.map((d) => d.id)).size !== this.docs.length)
      throw new Error("Duplicate retrieval document ID");
    this.index = new BM25(this.docs.map((d) => d.text));
    this.snapshotHash = hash(this.docs);
    this.executionHash = hash({
      documents: this.snapshotHash,
      edges: data.edges,
      datasetVersion: data.version,
      vectors: vectors?.fingerprint ?? "lexical-only",
    });
  }
  async search(
    role: Role,
    query: string,
    opts: { kind?: KnowledgeDoc["kind"]; ids?: string[]; limit?: number },
    signal: AbortSignal,
  ) {
    const allowed = this.docs.flatMap((d, i) =>
      d.roles.includes(role) &&
      (!opts.kind || opts.kind === d.kind) &&
      (!opts.ids || opts.ids.includes(d.id))
        ? [i]
        : [],
    );
    const limit = Math.min(15, Math.max(1, opts.limit ?? 8));
    const lexical = this.index.rank(query, allowed, Math.max(limit * 3, 30));
    const scores = new Map<number, number>();
    const passages = new Map<
      number,
      { start: number; end: number; chunkId: string }
    >();
    lexical.forEach((x, r) => scores.set(x.i, 1 / (60 + r + 1)));
    if (this.vectors) {
      const semantic = await this.vectors.rank(
        query,
        allowed.map((i) => this.docs[i]!.id),
        signal,
      );
      const byId = new Map(allowed.map((i) => [this.docs[i]!.id, i]));
      semantic.slice(0, Math.max(limit * 3, 30)).forEach((x, r) => {
        const i = byId.get(x.id);
        if (i !== undefined) {
          scores.set(i, (scores.get(i) ?? 0) + 1 / (60 + r + 1));
          if (x.passage) passages.set(i, x.passage);
        }
      });
    }
    return [...scores]
      .sort((a, b) => b[1] - a[1] || a[0] - b[0])
      .slice(0, limit)
      .map(([i, score]) => {
        const doc = this.docs[i]!,
          passage = passages.get(i);
        const position =
          passage?.start ??
          Math.max(
            0,
            ...tokenize(query).map((t) => doc.text.toLowerCase().indexOf(t)),
          );
        let start =
          doc.text.length <= 4000
            ? 0
            : Math.max(0, Math.min(position - 400, doc.text.length - 4000));
        let end = Math.min(doc.text.length, start + 4000);
        // Keep UTF-16 offsets while avoiding a split surrogate pair.
        if (start > 0 && /[\uDC00-\uDFFF]/.test(doc.text[start]!)) start--;
        if (end < doc.text.length && /[\uDC00-\uDFFF]/.test(doc.text[end]!))
          end--;
        return {
          evidence: { ...this.evidence(doc), text: doc.text.slice(start, end) },
          score,
          passage,
          excerpt: {
            start,
            end,
            totalChars: doc.text.length,
            complete: start === 0 && end === doc.text.length,
          },
          mode: this.vectors ? "hybrid-rrf" : "lexical-bm25",
        };
      });
  }
  evidence(d: KnowledgeDoc): Evidence {
    return {
      id: d.id,
      sourceId: d.sourceId,
      text: d.text,
      kind: d.kind,
      version: this.data.version,
    };
  }
  get(role: Role, id: string): Evidence {
    const d = this.docs.find((d) => d.id === id && d.roles.includes(role));
    if (!d)
      throw new Error("Evidence missing or not accessible to active expert");
    return this.evidence(d);
  }
  publishedSource(grant: Evidence): Evidence {
    const doc = this.docs.find((d) => d.id === grant.id);
    if (!doc) return grant; // Run-local resume, graph, memory or artifact evidence.
    if (
      grant.version !== this.data.version ||
      grant.sourceId !== doc.sourceId ||
      grant.kind !== doc.kind ||
      !grant.text ||
      ![grant.text, ...(grant.readTexts ?? [])].every((text) =>
        doc.text.includes(text),
      )
    )
      throw new Error(
        "Published source does not match current knowledge provenance",
      );
    // Explicit upstream publication delegates read access to this source ID only.
    return this.evidence(doc);
  }
  paths(
    start: string,
    target: string | undefined,
    mode: Constraints["pathMode"],
    maxDepth = 4,
  ) {
    if (!this.data.categories.some((c) => c.id === start))
      throw new Error("Unknown starting category");
    const results: Array<{
      nodes: string[];
      edges: Dataset["edges"];
      cost: number;
    }> = [];
    const visit = (nodes: string[], edges: Dataset["edges"], cost: number) => {
      if (edges.length && (target ? nodes.at(-1) === target : true))
        results.push({ nodes, edges, cost });
      if (
        edges.length >= maxDepth ||
        results.length >= 200 ||
        (target && nodes.at(-1) === target)
      )
        return;
      for (const edge of this.data.edges.filter(
        (e) => e.source === nodes.at(-1) && !nodes.includes(e.target),
      )) {
        const preference =
          mode === "progressive"
            ? edge.type === "promotion"
              ? 0
              : 0.4
            : mode === "transfer"
              ? edge.type === "transfer"
                ? 0
                : 0.4
              : 0;
        visit(
          [...nodes, edge.target],
          [...edges, edge],
          cost + 1 - Math.max(0, Math.min(1, edge.score)) + preference,
        );
      }
    };
    visit([start], [], 0);
    return results
      .sort((a, b) => a.cost - b.cost || a.nodes.length - b.nodes.length)
      .slice(0, 10);
  }
}
