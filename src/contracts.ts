import { z } from "zod";

export const Roles = ["profile", "match", "path", "report"] as const;
export const Role = z.enum(Roles);
export type Role = z.infer<typeof Role>;
export const PROFILE_SCORING_VERSION = "anchored-levels-v2-uncalibrated";
export const Dimensions = [
  "professionalSkill",
  "certificate",
  "innovation",
  "internalMotivation",
  "learning",
  "stressTolerance",
  "communication",
  "internship",
  "language",
  "leadership",
  "adaptability",
  "execution",
] as const;
export const Architecture = z.enum(["multi-agent", "skills"]);
export const Constraints = z
  .object({
    cities: z.array(z.string()).default([]),
    minMonthlySalary: z.number().nonnegative().optional(),
    education: z
      .enum(["不限", "高中", "大专", "本科", "硕士", "博士"])
      .optional(),
    experienceYears: z.number().nonnegative().optional(),
    weekendsOff: z.boolean().optional(),
    skills: z.array(z.string()).default([]),
    targetCategory: z.string().optional(),
    pathMode: z
      .enum(["balanced", "progressive", "transfer"])
      .default("balanced"),
  })
  .strict();
export type Constraints = z.infer<typeof Constraints>;
export const Request = z
  .object({
    userId: z.string().min(1).max(128),
    conversationId: z.string().min(1).max(128),
    request: z.string().min(1).max(40000),
    resumeText: z.string().max(150000).default(""),
    constraints: Constraints.default({
      cities: [],
      skills: [],
      pathMode: "balanced",
    }),
    architecture: Architecture.default("multi-agent"),
    approvalRequired: z.boolean().default(false),
  })
  .strict();
export type Request = z.infer<typeof Request>;
export const FollowUp = z
  .object({
    operationId: z.string().regex(/^[a-zA-Z0-9_.-]{1,128}$/),
    reply: z.string().trim().min(1).max(20000),
    resumeText: z.string().max(150000).optional(),
    constraints: Constraints.optional(),
  })
  .strict();
export type FollowUp = z.infer<typeof FollowUp>;
export interface Continuation {
  version: "user-reply-v1" | "user-reply-v2";
  questionPolicy?: "complete-open-questions-v1";
  parentRunId: string;
  operationId: string;
  parentRequestHash: string;
  requestHash: string;
  reply: string;
  resumeReplaced: boolean;
  constraintsReplaced: boolean;
  questions: Array<{
    artifactId: string;
    expert: Role;
    kind: "unknown" | "user_input";
    text: string;
  }>;
  snapshotHash: string;
}
export const PlanStep = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/),
    expert: Role,
    objective: z.string().min(1).max(3000),
    dependsOn: z.array(z.string()).max(8),
  })
  .strict();
export const Plan = z
  .object({
    rationale: z.string().max(2000),
    steps: z.array(PlanStep).min(1).max(8),
  })
  .strict();
export type Plan = z.infer<typeof Plan>;
export type Step = Plan["steps"][number];
export function validatePlan(input: unknown): Plan {
  const plan = Plan.parse(input),
    ids = new Set(plan.steps.map((s) => s.id));
  if (ids.size !== plan.steps.length) throw new Error("Duplicate step IDs");
  const visiting = new Set<string>(),
    visited = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error("Cyclic plan");
    if (visited.has(id)) return;
    const step = plan.steps.find((s) => s.id === id);
    if (!step) throw new Error(`Missing dependency: ${id}`);
    visiting.add(id);
    step.dependsOn.forEach(visit);
    visiting.delete(id);
    visited.add(id);
  };
  plan.steps.forEach((s) => visit(s.id));
  return plan;
}
export const Evidence = z.object({
  id: z.string(),
  sourceId: z.string(),
  text: z.string(),
  kind: z.enum([
    "resume",
    "request",
    "job",
    "category",
    "graph",
    "rule",
    "artifact",
    "memory",
    "calculation",
  ]),
  version: z.string(),
  // Internal read ledger. Never implies that unseen text was inspected.
  readTexts: z.array(z.string()).optional(),
});
export type Evidence = z.infer<typeof Evidence>;
export const CollaborationRequest = z
  .object({
    kind: z.enum(["evidence", "conflict", "assistance", "user_input"]),
    targetStepId: z.string().nullable(),
    targetRole: Role.optional(),
    question: z.string().min(1).max(2000),
    evidenceIds: z.array(z.string()).max(20),
  })
  .strict();
export type CollaborationRequest = z.infer<typeof CollaborationRequest>;
export const ExpertResult = z
  .object({
    status: z.enum(["succeeded", "partial", "needs_input", "failed"]),
    summary: z.string().max(6000),
    evidenceIds: z.array(z.string()).max(80),
    unknowns: z.array(z.string()).max(30),
    conflicts: z.array(z.string()).max(30),
    nextActions: z.array(z.string()).max(20),
    artifact: z.record(z.string(), z.unknown()),
    collaboration: CollaborationRequest.optional(),
  })
  .strict();
export type ExpertResult = z.infer<typeof ExpertResult>;
export interface Artifact {
  id: string;
  runId: string;
  stepId: string;
  expert: Role;
  result: ExpertResult;
  version: number;
  publishedEvidence?: Evidence[];
  attempt?: number;
  executionId?: string;
  inputArtifactIds?: string[];
  failure?: { code: string; retryable: boolean; message: string };
  reuse?: {
    sourceArtifactId: string;
    policy: "resume-facts-v1" | "resume-facts-v2";
  };
}
export const Job = z.object({
  id: z.string(),
  title: z.string(),
  city: z.string(),
  categoryId: z.string().nullable(),
  family: z.string(),
  level: z.string(),
  jd: z.string(),
  company: z.string(),
  source: z.string(),
  updatedAt: z.string(),
  salaryMin: z.number().nullable(),
  salaryMax: z.number().nullable(),
  educationRank: z.number().nullable(),
  experienceMin: z.number().nullable(),
  weekendsOff: z.boolean().nullable(),
  skills: z.array(z.string()),
  raw: z.record(z.string(), z.unknown()).optional(),
});
export type Job = z.infer<typeof Job>;
export interface Category {
  id: string;
  title: string;
  family: string;
  level: string;
  summary: string;
  skills: string[];
  abilities: Record<string, number>;
}
export interface Edge {
  source: string;
  target: string;
  type: "promotion" | "transfer";
  score: number;
  reason: string;
}
export interface KnowledgeDoc {
  id: string;
  text: string;
  sourceId: string;
  kind: Evidence["kind"];
  roles: Role[];
  categoryId?: string;
}
export interface Dataset {
  version: string;
  label: string;
  source: "synthetic" | "private";
  jobs: Job[];
  categories: Category[];
  edges: Edge[];
  documents: KnowledgeDoc[];
}
export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}
export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}
export interface Usage {
  input: number | null;
  output: number | null;
  cachedInput: number | null;
}
export interface ModelReply {
  message: Message;
  usage: Usage;
  finishReason: string;
}
export interface ProviderProgress {
  sequence: number;
  contentDelta?: string;
  toolDeltas?: Array<{
    index: number;
    id?: string;
    name?: string;
    arguments?: string;
  }>;
  usage?: Usage;
  finishReason?: string;
  done?: boolean;
}
export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}
export interface ModelProvider {
  readonly model: string;
  readonly mode: "live" | "replay";
  complete(
    messages: Message[],
    tools: ToolDefinition[],
    signal: AbortSignal,
    delta?: (text: string) => void,
    progress?: (frame: ProviderProgress) => void,
  ): Promise<ModelReply>;
}
export type RunStatus =
  | "created"
  | "running"
  | "waiting_approval"
  | "succeeded"
  | "partial"
  | "failed"
  | "cancelled"
  | "rejected"
  | "stale";
export interface RunRecord {
  id: string;
  request: Request;
  status: RunStatus;
  mode: "live" | "replay";
  datasetVersion: string;
  configHash: string;
  constraintVersion: number;
  inputVersion?: number;
  continuation?: Continuation;
  memorySnapshot?: string;
  createdAt: string;
  updatedAt: string;
  error?: string;
  answer?: string;
  finalReview?: {
    status: "model_checked" | "disabled" | "withheld";
    revisions: number;
    reason?: string;
  };
}
export interface Event {
  schemaVersion: 1;
  eventId: string;
  seq: number;
  runId: string;
  type: string;
  expert: string;
  callId: string;
  timestamp: string;
  payload: unknown;
}
export const MemoryProposal = z
  .object({
    operation: z.enum(["upsert", "retract"]).default("upsert"),
    namespace: z.enum(["shared", ...Roles]),
    key: z.string().regex(/^[a-zA-Z0-9_.-]{1,80}$/),
    value: z.string().max(4000).default(""),
    evidenceIds: z.array(z.string()).min(1),
    expiresAt: z.string().datetime().optional(),
    expectedVersion: z.number().int().nonnegative().default(0),
  })
  .strict();
export type MemoryProposal = z.infer<typeof MemoryProposal>;
export const MemoryChange = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("correct"),
      operationId: z.string().regex(/^[a-zA-Z0-9_.-]{1,128}$/),
      namespace: z.enum(["shared", ...Roles]),
      key: z.string().regex(/^[a-zA-Z0-9_.-]{1,80}$/),
      expectedVersion: z.number().int().positive(),
      value: z.string().min(1).max(4000),
      reason: z.string().min(1).max(2000),
      expiresAt: z.string().datetime().optional(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("retract"),
      operationId: z.string().regex(/^[a-zA-Z0-9_.-]{1,128}$/),
      namespace: z.enum(["shared", ...Roles]),
      key: z.string().regex(/^[a-zA-Z0-9_.-]{1,80}$/),
      expectedVersion: z.number().int().positive(),
      reason: z.string().min(1).max(2000),
    })
    .strict(),
]);
export type MemoryChange = z.infer<typeof MemoryChange>;
export interface ApprovalRecord {
  approvalId: string;
  snapshotHash: string;
  artifactIds: string[];
  proposalIds: string[];
  status: "pending" | "committed";
  decision?: "approve" | "reject";
}
