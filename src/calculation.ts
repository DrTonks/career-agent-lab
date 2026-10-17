import { z } from "zod";
import { hash } from "./config.js";
import { Evidence, Role } from "./contracts.js";

export const Calculation = z
  .object({
    schema: z.literal("tool-calculation-v1"),
    runId: z.string(),
    executionId: z.string(),
    role: Role,
    constraintVersion: z.number().int().positive(),
    datasetVersion: z.string(),
    knowledgeHash: z.string(),
    tool: z.enum([
      "jobs_search",
      "graph_paths",
      "graph_route",
      "memory_recall",
    ]),
    arguments: z.record(z.string(), z.unknown()),
    result: z.record(z.string(), z.unknown()),
  })
  .strict();
export type Calculation = z.infer<typeof Calculation>;

export function calculationEvidence(
  input: Omit<Calculation, "schema">,
): Evidence {
  const body = Calculation.parse({ schema: "tool-calculation-v1", ...input });
  const text = JSON.stringify(body),
    version = hash(text);
  const id = `calculation:${body.runId}:${version}`;
  return { id, sourceId: id, version, kind: "calculation", text };
}

/** Hash binding is necessary but not authorization; callers must also check the run and stored receipt. */
export function parseCalculation(source: Evidence): Calculation {
  const body = Calculation.parse(JSON.parse(source.text));
  if (
    source.kind !== "calculation" ||
    source.version !== hash(source.text) ||
    source.id !== `calculation:${body.runId}:${source.version}` ||
    source.sourceId !== source.id
  )
    throw Error("Calculation evidence identity mismatch");
  return body;
}
