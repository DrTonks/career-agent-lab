import {
  BaseCheckpointSaver,
  WRITES_IDX_MAP,
  compareWritesSortKeys,
  writesSortKey,
  type Checkpoint,
  type CheckpointMetadata,
  type CheckpointTuple,
  type CheckpointListOptions,
  type PendingWrite,
} from "@langchain/langgraph-checkpoint";
import type { RunnableConfig } from "@langchain/core/runnables";
import { Store } from "./storage.js";

/** SQLite durable saver using Node's built-in sqlite; no native addon dependency. */
export class SqliteSaver extends BaseCheckpointSaver {
  constructor(private store: Store) {
    super();
    store.db.exec(`
    CREATE TABLE IF NOT EXISTS checkpoints(thread_id TEXT NOT NULL,ns TEXT NOT NULL,id TEXT NOT NULL,parent TEXT,type TEXT NOT NULL,data BLOB NOT NULL,meta_type TEXT NOT NULL,meta BLOB NOT NULL,PRIMARY KEY(thread_id,ns,id));
    CREATE TABLE IF NOT EXISTS checkpoint_writes(thread_id TEXT NOT NULL,ns TEXT NOT NULL,id TEXT NOT NULL,task TEXT NOT NULL,idx INTEGER NOT NULL,path TEXT NOT NULL,channel TEXT NOT NULL,type TEXT NOT NULL,data BLOB NOT NULL,PRIMARY KEY(thread_id,ns,id,task,idx));
  `);
  }
  private keys(config: RunnableConfig) {
    const c = config.configurable ?? {};
    if (typeof c.thread_id !== "string" || !c.thread_id)
      throw new Error("thread_id required");
    return {
      thread: c.thread_id,
      ns: String(c.checkpoint_ns ?? ""),
      id: c.checkpoint_id as string | undefined,
    };
  }
  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const { thread, ns, id } = this.keys(config);
    const row = id
      ? this.store.db
          .prepare(
            "SELECT * FROM checkpoints WHERE thread_id=? AND ns=? AND id=?",
          )
          .get(thread, ns, id)
      : this.store.db
          .prepare(
            "SELECT * FROM checkpoints WHERE thread_id=? AND ns=? ORDER BY id DESC LIMIT 1",
          )
          .get(thread, ns);
    if (!row) return undefined;
    const cfg = {
      configurable: {
        thread_id: thread,
        checkpoint_ns: ns,
        checkpoint_id: String(row.id),
      },
    };
    const writes = this.store.db
      .prepare(
        "SELECT * FROM checkpoint_writes WHERE thread_id=? AND ns=? AND id=?",
      )
      .all(thread, ns, String(row.id));
    writes.sort((a, b) =>
      compareWritesSortKeys(
        writesSortKey(String(a.path), String(a.task), Number(a.idx)),
        writesSortKey(String(b.path), String(b.task), Number(b.idx)),
      ),
    );
    return {
      config: cfg,
      checkpoint: await this.serde.loadsTyped(
        String(row.type),
        row.data as Uint8Array,
      ),
      metadata: await this.serde.loadsTyped(
        String(row.meta_type),
        row.meta as Uint8Array,
      ),
      parentConfig: row.parent
        ? {
            configurable: {
              thread_id: thread,
              checkpoint_ns: ns,
              checkpoint_id: String(row.parent),
            },
          }
        : undefined,
      pendingWrites: await Promise.all(
        writes.map(
          async (r) =>
            [
              String(r.task),
              String(r.channel),
              await this.serde.loadsTyped(String(r.type), r.data as Uint8Array),
            ] as [string, string, unknown],
        ),
      ),
    };
  }
  async *list(
    config: RunnableConfig,
    options: CheckpointListOptions = {},
  ): AsyncGenerator<CheckpointTuple> {
    const { thread, ns } = this.keys(config);
    const rows = this.store.db
      .prepare(
        "SELECT id FROM checkpoints WHERE thread_id=? AND ns=? ORDER BY id DESC",
      )
      .all(thread, ns);
    let count = 0;
    for (const row of rows) {
      if (
        options.before?.configurable?.checkpoint_id &&
        String(row.id) >= String(options.before.configurable.checkpoint_id)
      )
        continue;
      const tuple = await this.getTuple({
        configurable: {
          thread_id: thread,
          checkpoint_ns: ns,
          checkpoint_id: row.id,
        },
      });
      if (
        !tuple ||
        Object.entries(options.filter ?? {}).some(
          ([k, v]) => (tuple.metadata as Record<string, unknown>)?.[k] !== v,
        )
      )
        continue;
      if (options.limit !== undefined && count >= options.limit) break;
      count++;
      yield tuple;
    }
  }
  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
  ): Promise<RunnableConfig> {
    const { thread, ns, id } = this.keys(config),
      [type, data] = await this.serde.dumpsTyped(checkpoint),
      [mt, md] = await this.serde.dumpsTyped(metadata);
    this.store.transaction(() => {
      this.store.assertLease(thread.split("::")[0]!);
      this.store.db
        .prepare("INSERT OR REPLACE INTO checkpoints VALUES(?,?,?,?,?,?,?,?)")
        .run(thread, ns, checkpoint.id, id ?? null, type, data, mt, md);
    });
    return {
      configurable: {
        thread_id: thread,
        checkpoint_ns: ns,
        checkpoint_id: checkpoint.id,
      },
    };
  }
  async putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string,
    taskPath = "",
  ): Promise<void> {
    const { thread, ns, id } = this.keys(config);
    if (!id) throw new Error("checkpoint_id required");
    const encoded = await Promise.all(
      writes.map(async ([channel, value], i) => ({
        channel,
        idx: WRITES_IDX_MAP[channel] ?? i,
        data: await this.serde.dumpsTyped(value),
      })),
    );
    this.store.transaction(() => {
      this.store.assertLease(thread.split("::")[0]!);
      for (const w of encoded) {
        const mode = w.idx < 0 ? "REPLACE" : "IGNORE";
        this.store.db
          .prepare(
            `INSERT OR ${mode} INTO checkpoint_writes VALUES(?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            thread,
            ns,
            id,
            taskId,
            w.idx,
            taskPath,
            w.channel,
            w.data[0],
            w.data[1],
          );
      }
    });
  }
  async deleteThread(threadId: string): Promise<void> {
    this.store.transaction(() => {
      this.store.db
        .prepare("DELETE FROM checkpoint_writes WHERE thread_id=?")
        .run(threadId);
      this.store.db
        .prepare("DELETE FROM checkpoints WHERE thread_id=?")
        .run(threadId);
    });
  }
}
