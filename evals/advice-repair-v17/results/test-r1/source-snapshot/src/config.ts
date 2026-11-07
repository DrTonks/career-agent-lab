import { createHash } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, readdirSync } from "node:fs";
function projectRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(resolve(dir, "package.json"))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error("Cannot locate project package.json");
    dir = parent;
  }
  return dir;
}
export const ROOT = projectRoot();
export function implementationHash(): string {
  return hash(
    readdirSync(resolve(ROOT, "src"))
      .filter((n) => n.endsWith(".ts"))
      .sort()
      .map((n) => [n, readFileSync(resolve(ROOT, "src", n), "utf8")]),
  );
}
export function hash(value: unknown): string {
  return createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");
}
export function loadEnv(root = ROOT): void {
  const path = resolve(root, ".env");
  if (existsSync(path)) process.loadEnvFile(path);
}
export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "")) as T;
}
function num(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`Invalid ${name}`);
  return value;
}
function count(name: string, fallback: number) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 0) throw Error(`Invalid ${name}`);
  return value;
}
export function config() {
  const maxTurns = count("CAREER_MAX_EXPERT_TURNS", 10);
  if (maxTurns < 1) throw Error("CAREER_MAX_EXPERT_TURNS must be positive");
  const maxPlanningTurns = count("CAREER_MAX_PLANNING_TURNS", 12);
  if (maxPlanningTurns < 1)
    throw Error("CAREER_MAX_PLANNING_TURNS must be positive");
  const finalReview = process.env.CAREER_FINAL_REVIEW ?? "model";
  if (finalReview !== "model" && finalReview !== "off")
    throw new Error("CAREER_FINAL_REVIEW must be model or off");
  const reviewTransport = process.env.CAREER_REVIEW_TRANSPORT ?? "chat-tools";
  if (reviewTransport !== "chat-tools" && reviewTransport !== "deepseek-strict")
    throw Error(
      "CAREER_REVIEW_TRANSPORT must be chat-tools or deepseek-strict",
    );
  return {
    finalReview,
    reviewTransport,
    reviewUnitsPerPart: num("CAREER_REVIEW_UNITS_PER_PART", 16),
    reviewSourceTokens: num("CAREER_REVIEW_SOURCE_TOKENS", 8000),
    model: process.env.CAREER_MODEL ?? "",
    baseUrl: (
      process.env.CAREER_BASE_URL ?? "https://api.deepseek.com"
    ).replace(/\/$/, ""),
    maxCalls: num("CAREER_MAX_CALLS", 60),
    maxInputTokens: num("CAREER_MAX_INPUT_TOKENS", 600000),
    maxOutputTokens: num("CAREER_MAX_OUTPUT_TOKENS", 80000),
    finalReserveCalls: count("CAREER_FINAL_RESERVE_CALLS", 24),
    finalReserveInputTokens: count("CAREER_FINAL_RESERVE_INPUT_TOKENS", 240000),
    finalReserveOutputTokens: count(
      "CAREER_FINAL_RESERVE_OUTPUT_TOKENS",
      32768,
    ),
    requestTimeoutMs: num("CAREER_REQUEST_TIMEOUT_MS", 90000),
    maxRunMs: num("CAREER_MAX_RUN_MS", 900000),
    maxContextTokens: num("CAREER_MAX_CONTEXT_TOKENS", 48000),
    activeContextTarget: num("CAREER_ACTIVE_CONTEXT_TARGET", 22000),
    maxResponseTokens: num("CAREER_MAX_RESPONSE_TOKENS", 4096),
    maxTurns,
    maxPlanningTurns,
    concurrency: 2,
    leaseTtlMs: 5000,
    maxCoordinationRounds: 3,
    maxStepAttempts: 3,
  };
}
export type Config = ReturnType<typeof config>;
// Upper estimate for budget enforcement, never reported as provider token usage.
export function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / 2);
}
