import { z } from "zod";
import { hash } from "./config.js";
import { BM25 } from "./retrieval.js";
export const MemoryQuery = z
  .object({
    query: z.string().max(2000).default(""),
    limit: z.number().int().min(1).max(20).default(8),
    cursor: z.string().max(2048).optional(),
    includeInactive: z.boolean().default(false),
  })
  .strict();
export interface MemoryRow {
  namespace: string;
  key: string;
  value: string;
  version: number;
  evidence: string;
  updated_at: string;
  expires_at: string | null;
  state: "active" | "expired" | "retracted";
}
/** Caller must filter user/namespace BEFORE providing rows or computing BM25. */
export function searchMemories(
  rows: MemoryRow[],
  input: z.input<typeof MemoryQuery>,
  scope: string,
  snapshot: string,
) {
  const query = MemoryQuery.parse(input);
  const identity = hash({
    scope,
    snapshot,
    query: query.query,
    includeInactive: query.includeInactive,
  });
  let offset = 0;
  if (query.cursor) {
    let cursor: { identity: string; offset: number };
    try {
      cursor = JSON.parse(
        Buffer.from(query.cursor, "base64url").toString("utf8"),
      );
    } catch {
      throw new Error("Invalid memory cursor");
    }
    if (
      cursor.identity !== identity ||
      !Number.isInteger(cursor.offset) ||
      cursor.offset < 0
    )
      throw new Error(
        "Memory cursor does not match user, role, query or current version snapshot",
      );
    offset = cursor.offset;
  }
  const visible = rows
    .filter((r) => query.includeInactive || r.state === "active")
    .sort(
      (a, b) =>
        b.updated_at.localeCompare(a.updated_at) ||
        a.namespace.localeCompare(b.namespace) ||
        a.key.localeCompare(b.key),
    );
  // Inactive values must never affect ranking or leak through a returned page.
  const ranked = query.query.trim()
    ? new BM25(
        visible.map(
          (r) =>
            `${r.namespace} ${r.key} ${r.state === "active" ? r.value : ""}`,
        ),
      )
        .rank(
          query.query,
          visible.map((_, i) => i),
          visible.length,
        )
        .map((h) => ({ ...visible[h.i]!, score: h.score }))
    : visible.map((r) => ({ ...r, score: null }));
  const items = ranked
    .slice(offset, offset + query.limit)
    .map((r) =>
      r.state === "active" ? r : { ...r, value: "", evidence: "[]" },
    );
  const next = offset + items.length;
  return {
    items,
    totalAvailable: visible.length,
    totalMatches: ranked.length,
    nextCursor:
      next < ranked.length
        ? Buffer.from(JSON.stringify({ identity, offset: next })).toString(
            "base64url",
          )
        : null,
    mode: query.query.trim() ? "lexical-bm25" : "recent",
    snapshot,
    query: query.query,
  };
}
