import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { hash } from "./config.js";
import { FollowUp, Request, type RunRecord } from "./contracts.js";
import { continuationContext, followUpInput } from "./follow-up.js";

export interface UserInputTurn {
  sourceId: string;
  runId: string;
  parentRunId: string | null;
  operationId: string | null;
  inputVersion: number;
  text: string;
  textHash: string;
  requestHash: string;
  continuationHash: string | null;
  resumeHash: string;
  constraintsHash: string;
  resumeReplaced: boolean;
  constraintsReplaced: boolean;
}

/** Raw user input only. This view neither grants citations nor includes assistant
 * answers. Existing atomic replies and command receipts are the durable ledger;
 * no duplicated table/backfill is needed for historical v1 executions.
 */
export function conversationInputs(
  db: DatabaseSync,
  runId: string,
  userId: string,
) {
  if (!userId || !runId) throw Error("Input history requires an owned run");
  db.exec("SAVEPOINT input_history_snapshot");
  try {
    const seen = new Set<string>(),
      chain: RunRecord[] = [];
    let id: string | undefined = runId;
    while (id) {
      if (seen.has(id)) throw Error("Input history contains a parent cycle");
      seen.add(id);
      const row = db
        .prepare(
          "SELECT id,user_id,conversation_id,body FROM runs WHERE id=? AND user_id=?",
        )
        .get(id, userId);
      if (!row) throw Error("Input history not found or not owned by user");
      const run = JSON.parse(String(row.body)) as RunRecord;
      Request.parse(run.request);
      if (
        run.id !== row.id ||
        run.request.userId !== row.user_id ||
        run.request.conversationId !== row.conversation_id ||
        !Number.isSafeInteger(run.inputVersion ?? 0) ||
        (run.inputVersion ?? 0) < 0 ||
        (chain.length > 0 &&
          (run.request.conversationId !== chain[0]!.request.conversationId ||
            run.request.architecture !== chain[0]!.request.architecture))
      )
        throw Error("Input history identity/version mismatch");
      if (run.continuation) {
        if (
          !["user-reply-v1", "user-reply-v2"].includes(run.continuation.version)
        )
          throw Error("Unsupported input history continuation version");
        continuationContext(run);
      }
      chain.push(run);
      id = run.continuation?.parentRunId;
    }
    chain.reverse();
    const turns: UserInputTurn[] = chain.map((run, index) => {
      const parent = chain[index - 1],
        c = run.continuation;
      const commands = db
        .prepare("SELECT * FROM follow_up_commands WHERE child_id=?")
        .all(run.id);
      if (!parent) {
        if (c || commands.length)
          throw Error("Root input has an unexpected command");
      } else {
        if (!c || (run.inputVersion ?? 0) !== (parent.inputVersion ?? 0) + 1)
          throw Error("Input history version sequence mismatch");
        const command = FollowUp.parse({
          operationId: c.operationId,
          reply: c.reply,
          ...(c.resumeReplaced ? { resumeText: run.request.resumeText } : {}),
          ...(c.constraintsReplaced
            ? { constraints: run.request.constraints }
            : {}),
        });
        if (
          commands.length !== 1 ||
          commands[0]!.user_id !== userId ||
          commands[0]!.parent_id !== parent.id ||
          commands[0]!.operation_id !== c.operationId ||
          commands[0]!.request_hash !== hash(command) ||
          c.parentRequestHash !== hash(parent.request) ||
          hash(followUpInput(parent, command, [], c.version).request) !==
            hash(run.request)
        )
          throw Error("Input history command/request mismatch");
      }
      // Never split old concatenated strings on model/user-controllable delimiters.
      const text = c ? c.reply : run.request.request;
      return {
        sourceId: `input:${runId}:turn:${run.inputVersion ?? 0}:request`,
        runId: run.id,
        parentRunId: c?.parentRunId ?? null,
        operationId: c?.operationId ?? null,
        inputVersion: run.inputVersion ?? 0,
        text,
        textHash: hash(text),
        requestHash: hash(run.request),
        continuationHash: c?.snapshotHash ?? null,
        resumeHash: hash(run.request.resumeText),
        constraintsHash: hash(run.request.constraints),
        resumeReplaced: c?.resumeReplaced ?? true,
        constraintsReplaced: c?.constraintsReplaced ?? true,
      };
    });
    const schemaVersion = "user-input-timeline-v1" as const;
    return {
      schemaVersion,
      runId,
      snapshotHash: hash([schemaVersion, runId, turns]),
      turns,
    };
  } finally {
    db.exec("RELEASE input_history_snapshot");
  }
}

const View = z
  .object({
    runId: z.string().min(1),
    userId: z.string().min(1),
    snapshotHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();
type HistoryView = z.infer<typeof View>;
function view(db: DatabaseSync, identity: HistoryView) {
  const parsed = View.parse(identity);
  const result = conversationInputs(db, parsed.runId, parsed.userId);
  if (parsed.snapshotHash && result.snapshotHash !== parsed.snapshotHash)
    throw Error("Input history snapshot changed");
  return result;
}

/** Metadata is deliberately not a read receipt or primary evidence. */
export function inputHistoryPage(
  db: DatabaseSync,
  identity: HistoryView,
  args: { offset?: number; limit?: number; query?: string } = {},
) {
  const { offset, limit, query } = z
    .object({
      offset: z
        .number()
        .int()
        .nonnegative()
        .max(Number.MAX_SAFE_INTEGER)
        .default(0),
      limit: z.number().int().min(1).max(20).default(10),
      query: z.string().trim().min(1).max(200).optional(),
    })
    .strict()
    .parse(args);
  const history = view(db, identity);
  // Authorize the ancestry before searching; never search all users/runs.
  const found = history.turns.filter(
    (t) =>
      !query || t.text.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
  );
  if (offset > found.length)
    throw Error("Input history page offset out of range");
  const entries = found.slice(offset, offset + limit).map(({ text, ...t }) => ({
    ...t,
    totalChars: text.length,
  }));
  return {
    schemaVersion: history.schemaVersion,
    snapshotHash: history.snapshotHash,
    totalTurns: history.turns.length,
    matchedTurns: found.length,
    entries,
    nextOffset:
      offset + entries.length < found.length ? offset + entries.length : null,
  };
}

/** A runtime tool must separately record read coverage and grant citations for
 * the returned range. Re-load ownership every time, including after forgetting.
 */
export function inputHistoryRead(
  db: DatabaseSync,
  identity: HistoryView,
  args: { sourceId: string; offset?: number; maxChars?: number },
) {
  const { sourceId, offset, maxChars } = z
    .object({
      sourceId: z.string().min(1),
      offset: z
        .number()
        .int()
        .nonnegative()
        .max(Number.MAX_SAFE_INTEGER)
        .default(0),
      maxChars: z.number().int().min(1).max(8000).default(4000),
    })
    .strict()
    .parse(args);
  const history = view(db, identity);
  const turn = history.turns.find((t) => t.sourceId === sourceId);
  if (!turn) throw Error("Source is outside this input history view");
  if (offset > turn.text.length)
    throw Error("Input history read offset out of range");
  const text = turn.text.slice(offset, offset + maxChars),
    end = offset + text.length;
  return {
    sourceId,
    snapshotHash: history.snapshotHash,
    inputVersion: turn.inputVersion,
    textHash: turn.textHash,
    text,
    offset,
    end,
    totalChars: turn.text.length,
    nextOffset: end < turn.text.length ? end : null,
  };
}
