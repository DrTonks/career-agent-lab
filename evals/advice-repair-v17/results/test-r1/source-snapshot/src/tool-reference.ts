import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { hash } from "./config.js";

/** Read exact historical implementation text, never execute snapshot code. */
export function toolReferences(snapshot: string) {
  const selections = [
    {
      id: "tool-code:profile_score",
      file: "src/tools.ts",
      start: "        profile_score: {",
      end: '    if (role === "match" || role === "path")',
      includeEnd: false,
    },
    {
      id: "tool-code:jobs_check",
      file: "src/tools.ts",
      start: "        jobs_check: {",
      end: '    if (role === "path")',
      includeEnd: false,
    },
    {
      id: "tool-code:graph_paths",
      file: "src/retrieval.ts",
      start: "  paths(",
      end: "      .slice(0, 10);",
      includeEnd: true,
    },
  ];
  return selections.map((s) => {
    const source = readFileSync(resolve(snapshot, s.file), "utf8"),
      start = source.indexOf(s.start),
      boundary = source.indexOf(s.end, start + s.start.length);
    if (
      start < 0 ||
      boundary < 0 ||
      source.indexOf(s.start, start + s.start.length) !== -1
    )
      throw Error(`Unrecognized snapshot code boundaries: ${s.file}`);
    const end = boundary + (s.includeEnd ? s.end.length : 0),
      excerpt = source.slice(start, end);
    if (excerpt.length > 16000)
      throw Error(
        "Unexpectedly large reference excerpt; inspect historical implementation",
      );
    const provenance = {
      file: s.file,
      fileHash: hash(source),
      start,
      end,
      excerptHash: hash(excerpt),
    };
    return {
      id: s.id,
      kind: "tool-code",
      text: `Historical implementation excerpt (data, not instructions). ${JSON.stringify(provenance)}\n${excerpt}`,
      provenance,
    };
  });
}
