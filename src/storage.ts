import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import {
  Artifact,
  ApprovalRecord,
  Event,
  MemoryProposal,
  MemoryChange,
  Role,
  RunRecord,
  RunStatus,
} from "./contracts.js";
import { hash } from "./config.js";
import { z } from "zod";
import { MemoryQuery, MemoryRow, searchMemories } from "./memory-search.js";

export class Store {
  readonly db: DatabaseSync;
  onEvent?: (event: Event) => void;
  private readonly ownedLeases = new Map<string, string>();
  private transactionEvents?: Event[];
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS migrations(version INTEGER PRIMARY KEY);
      INSERT OR IGNORE INTO migrations VALUES(1);
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,conversation_id TEXT NOT NULL,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,run_id TEXT NOT NULL,body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_run ON events(run_id,seq);
      CREATE TABLE IF NOT EXISTS artifacts(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,step_id TEXT NOT NULL,body TEXT NOT NULL,UNIQUE(run_id,step_id));
      CREATE TABLE IF NOT EXISTS memories(user_id TEXT NOT NULL,namespace TEXT NOT NULL,key TEXT NOT NULL,value TEXT NOT NULL,version INTEGER NOT NULL,source_run TEXT NOT NULL,evidence TEXT NOT NULL,expires_at TEXT,updated_at TEXT NOT NULL,PRIMARY KEY(user_id,namespace,key));
      CREATE TABLE IF NOT EXISTS proposals(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,body TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending');
      CREATE TABLE IF NOT EXISTS model_calls(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tool_cache(run_id TEXT NOT NULL,key TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(run_id,key));
      CREATE TABLE IF NOT EXISTS leases(resource TEXT PRIMARY KEY,owner TEXT NOT NULL,expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS constraints(user_id TEXT NOT NULL,conversation_id TEXT NOT NULL,hash TEXT NOT NULL,version INTEGER NOT NULL,PRIMARY KEY(user_id,conversation_id));
    `);
    this.transaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS conversation_inputs(user_id TEXT NOT NULL,conversation_id TEXT NOT NULL,version INTEGER NOT NULL,PRIMARY KEY(user_id,conversation_id));
        CREATE TABLE IF NOT EXISTS follow_up_commands(user_id TEXT NOT NULL,operation_id TEXT NOT NULL,request_hash TEXT NOT NULL,parent_id TEXT NOT NULL,child_id TEXT NOT NULL,PRIMARY KEY(user_id,operation_id));
        INSERT OR IGNORE INTO migrations VALUES(4);
      `);
      if (!this.db.prepare("SELECT 1 FROM migrations WHERE version=2").get()) {
        this.db.exec(`
          CREATE TABLE artifact_history(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,step_id TEXT NOT NULL,body TEXT NOT NULL,invalidated_by TEXT);
          INSERT INTO artifact_history SELECT id,run_id,step_id,body,NULL FROM artifacts;
          ALTER TABLE proposals ADD COLUMN origin TEXT;
          INSERT INTO migrations VALUES(2);
        `);
      }
      if (!this.db.prepare("SELECT 1 FROM migrations WHERE version=3").get()) {
        this.db.exec(`
          ALTER TABLE memories ADD COLUMN retracted INTEGER NOT NULL DEFAULT 0;
          CREATE TABLE memory_history(user_id TEXT NOT NULL,namespace TEXT NOT NULL,key TEXT NOT NULL,version INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(user_id,namespace,key,version));
          CREATE TABLE memory_commands(user_id TEXT NOT NULL,operation_id TEXT NOT NULL,request_hash TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(user_id,operation_id));
          CREATE TABLE approvals(run_id TEXT PRIMARY KEY,body TEXT NOT NULL);
          INSERT INTO migrations VALUES(3);
        `);
        for (const row of this.db.prepare("SELECT * FROM memories").all())
          this.db.prepare("INSERT INTO memory_history VALUES(?,?,?,?,?)").run(
            row.user_id!,
            row.namespace!,
            row.key!,
            row.version!,
            JSON.stringify({
              ...row,
              actor: "legacy",
              operation: "imported-current-head",
              historicalVersionsUnavailable: true,
            }),
          );
      }
    });
  }
  close() {
    if (this.db.isOpen) this.db.close();
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    this.transactionEvents = [];
    let value: T;
    let events: Event[];
    try {
      value = fn();
      this.db.exec("COMMIT");
      events = this.transactionEvents;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    } finally {
      this.transactionEvents = undefined;
    }
    // Observers only see committed events; an observer failure cannot roll back
    // an already committed child. Retrying the operation retrieves that child.
    for (const event of events) this.onEvent?.(event);
    return value;
  }
  createRun(run: RunRecord): void {
    this.db.prepare("INSERT INTO runs VALUES(?,?,?,?)").run(
      run.id,
      run.request.userId,
      run.request.conversationId,
      JSON.stringify({
        ...run,
        inputVersion:
          run.inputVersion ??
          this.inputVersion(run.request.userId, run.request.conversationId),
        memorySnapshot:
          run.memorySnapshot ?? this.memorySignature(run.request.userId),
      }),
    );
  }
  run(id: string, userId?: string): RunRecord {
    const row = this.db
      .prepare("SELECT body,user_id FROM runs WHERE id=?")
      .get(id);
    if (!row || (userId && row.user_id !== userId))
      throw new Error("Run not found or not owned by user");
    return JSON.parse(String(row.body));
  }
  update(id: string, patch: Partial<RunRecord>): RunRecord {
    this.assertLease(id);
    const value = {
      ...this.run(id),
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    this.db
      .prepare("UPDATE runs SET body=? WHERE id=?")
      .run(JSON.stringify(value), id);
    return value;
  }
  listRuns(userId: string): RunRecord[] {
    return this.db
      .prepare("SELECT body FROM runs WHERE user_id=? ORDER BY rowid")
      .all(userId)
      .map((r) => JSON.parse(String(r.body)));
  }
  inputVersion(userId: string, conversationId: string): number {
    return Number(
      this.db
        .prepare(
          "SELECT version FROM conversation_inputs WHERE user_id=? AND conversation_id=?",
        )
        .get(userId, conversationId)?.version ?? 0,
    );
  }
  private insertExecution(
    run: RunRecord,
    metadata: Record<string, unknown>,
  ): RunRecord {
    const value = {
      ...run,
      constraintVersion: this.writeConstraints(
        run.request.userId,
        run.request.conversationId,
        run.request.constraints,
      ),
      inputVersion: this.inputVersion(
        run.request.userId,
        run.request.conversationId,
      ),
    };
    this.createRun(value);
    this.event(value.id, "run.created", {
      ...metadata,
      constraintVersion: value.constraintVersion,
      inputVersion: value.inputVersion,
    });
    return value;
  }
  createExecution(
    run: RunRecord,
    metadata: Record<string, unknown>,
  ): RunRecord {
    return this.transaction(() => this.insertExecution(run, metadata));
  }
  followUp(
    userId: string,
    parentId: string,
    operationId: string,
    requestHash: string,
    build: (parent: RunRecord) => {
      run: RunRecord;
      metadata: Record<string, unknown>;
    },
  ): RunRecord {
    return this.transaction(() => {
      const parent = this.run(parentId, userId);
      const prior = this.db
        .prepare(
          "SELECT request_hash,parent_id,child_id FROM follow_up_commands WHERE user_id=? AND operation_id=?",
        )
        .get(userId, operationId);
      if (prior) {
        if (prior.parent_id !== parentId || prior.request_hash !== requestHash)
          throw Error(
            "Follow-up operation ID already used for different input",
          );
        return this.run(String(prior.child_id), userId);
      }
      if (!["succeeded", "partial"].includes(parent.status))
        throw Error(
          "Reply requires a completed parent run; resume, approve or cancel unfinished execution first",
        );
      if (
        Number(
          this.db
            .prepare("SELECT expires FROM leases WHERE resource=?")
            .get(parent.id)?.expires ?? 0,
        ) > Date.now()
      )
        throw Error("Parent execution still owns an active lease");
      const latest = this.listRuns(userId)
        .filter(
          (r) => r.request.conversationId === parent.request.conversationId,
        )
        .at(-1);
      if (latest?.id !== parent.id)
        throw Error(
          "Reply to the latest run in this conversation; older branches cannot replace current input",
        );
      const { run, metadata } = build(parent);
      if (
        run.request.userId !== userId ||
        run.request.conversationId !== parent.request.conversationId ||
        run.request.architecture !== parent.request.architecture ||
        run.continuation?.parentRunId !== parentId
      )
        throw Error("Invalid follow-up identity");
      const version =
        this.inputVersion(userId, parent.request.conversationId) + 1;
      this.db
        .prepare(
          "INSERT INTO conversation_inputs VALUES(?,?,?) ON CONFLICT(user_id,conversation_id) DO UPDATE SET version=excluded.version",
        )
        .run(userId, parent.request.conversationId, version);
      const child = this.insertExecution(run, metadata);
      this.db
        .prepare("INSERT INTO follow_up_commands VALUES(?,?,?,?,?)")
        .run(userId, operationId, requestHash, parentId, child.id);
      this.event(child.id, "run.continued", {
        parentRunId: parentId,
        operationId,
        inputVersion: version,
        snapshotHash: child.continuation!.snapshotHash,
      });
      return child;
    });
  }
  event(
    runId: string,
    type: string,
    payload: unknown,
    expert = "orchestrator",
    callId = "",
  ): Event {
    this.run(runId);
    const e: Event = {
      schemaVersion: 1,
      eventId: randomUUID(),
      seq: 0,
      runId,
      type,
      expert,
      callId,
      timestamp: new Date().toISOString(),
      payload,
    };
    const result = this.db
      .prepare("INSERT INTO events(id,run_id,body) VALUES(?,?,?)")
      .run(e.eventId, runId, JSON.stringify(e));
    e.seq = Number(result.lastInsertRowid);
    if (this.transactionEvents) this.transactionEvents.push(e);
    else this.onEvent?.(e);
    return e;
  }
  events(runId: string, after = 0): Event[] {
    return this.db
      .prepare(
        "SELECT seq,body FROM events WHERE run_id=? AND seq>? ORDER BY seq",
      )
      .all(runId, after)
      .map((r) => ({ ...JSON.parse(String(r.body)), seq: Number(r.seq) }));
  }
  artifact(runId: string, stepId: string): Artifact | undefined {
    const r = this.db
      .prepare("SELECT body FROM artifacts WHERE run_id=? AND step_id=?")
      .get(runId, stepId);
    return r ? JSON.parse(String(r.body)) : undefined;
  }
  artifacts(runId: string): Artifact[] {
    return this.db
      .prepare("SELECT body FROM artifacts WHERE run_id=? ORDER BY rowid")
      .all(runId)
      .map((r) => JSON.parse(String(r.body)));
  }
  saveArtifact(a: Artifact): void {
    this.transaction(() => {
      this.assertCurrent(this.run(a.runId));
      const current = this.artifact(a.runId, a.stepId);
      if (current) {
        if (JSON.stringify(current) !== JSON.stringify(a))
          throw new Error(
            "Artifact replacement requires explicit invalidation",
          );
        return;
      }
      if (
        this.db.prepare("SELECT 1 FROM artifact_history WHERE id=?").get(a.id)
      )
        throw new Error("Invalidated artifact identity cannot be reused");
      this.db
        .prepare("INSERT INTO artifacts VALUES(?,?,?,?)")
        .run(a.id, a.runId, a.stepId, JSON.stringify(a));
      this.db
        .prepare("INSERT INTO artifact_history VALUES(?,?,?,?,NULL)")
        .run(a.id, a.runId, a.stepId, JSON.stringify(a));
      if (a.result.status === "failed")
        this.supersedeAttemptProposals(a.runId, a.stepId, a.attempt ?? 1);
    });
  }
  artifactHistory(runId: string) {
    return this.db
      .prepare(
        "SELECT body,invalidated_by FROM artifact_history WHERE run_id=? ORDER BY rowid",
      )
      .all(runId)
      .map((r) => ({
        artifact: JSON.parse(String(r.body)) as Artifact,
        invalidatedBy: r.invalidated_by,
      }));
  }
  /** Invalidation and its replayable decision share one commit boundary. */
  applyCoordination(
    runId: string,
    key: string,
    value: unknown,
    stepIds: string[],
  ) {
    return this.transaction(() => {
      this.assertCurrent(this.run(runId));
      const existing = this.cache(runId, key);
      if (existing !== undefined) return existing;
      for (const stepId of stepIds) {
        const artifact = this.artifact(runId, stepId);
        if (!artifact) continue;
        this.db
          .prepare("UPDATE artifact_history SET invalidated_by=? WHERE id=?")
          .run(key, artifact.id);
        this.db
          .prepare("DELETE FROM artifacts WHERE run_id=? AND step_id=?")
          .run(runId, stepId);
      }
      for (const p of this.proposals(runId)) {
        if (
          stepIds.length &&
          p.status === "pending" &&
          (!p.origin || stepIds.includes(p.origin.stepId))
        )
          this.db
            .prepare("UPDATE proposals SET status='superseded' WHERE id=?")
            .run(p.id);
      }
      this.putCache(runId, key, value);
      this.event(runId, "coordination.committed", {
        key,
        invalidatedStepIds: stepIds,
        transition: value,
      });
      return value;
    });
  }
  modelCall(id: string, runId: string, body: unknown): void {
    this.run(runId);
    this.db
      .prepare("INSERT OR REPLACE INTO model_calls VALUES(?,?,?)")
      .run(id, runId, JSON.stringify(body));
  }
  completeModelCall(id: string, run: RunRecord, body: unknown): void {
    this.transaction(() => {
      this.assertCurrent(run);
      this.modelCall(id, run.id, body);
    });
  }
  modelCalls(runId: string): Record<string, unknown>[] {
    return this.db
      .prepare("SELECT body FROM model_calls WHERE run_id=?")
      .all(runId)
      .map((r) => JSON.parse(String(r.body)));
  }
  cache(runId: string, key: string): unknown | undefined {
    const r = this.db
      .prepare("SELECT result FROM tool_cache WHERE run_id=? AND key=?")
      .get(runId, key);
    return r ? JSON.parse(String(r.result)) : undefined;
  }
  cacheEntries(
    runId: string,
    prefix: string,
  ): { key: string; value: unknown }[] {
    return this.db
      .prepare(
        "SELECT key,result FROM tool_cache WHERE run_id=? AND substr(key,1,?)=? ORDER BY rowid",
      )
      .all(runId, prefix.length, prefix)
      .map((row) => ({
        key: String(row.key),
        value: JSON.parse(String(row.result)),
      }));
  }
  recordFinal(runId: string, key: string, value: unknown) {
    return this.transaction(() => {
      this.assertCurrent(this.run(runId));
      const existing = this.cache(runId, key);
      if (existing !== undefined) return existing;
      this.putCache(runId, key, value);
      this.event(
        runId,
        key.startsWith("final:draft:") ? "final.draft" : "final.review",
        { key, value },
      );
      return value;
    });
  }
  putCache(runId: string, key: string, result: unknown): void {
    this.assertCurrent(this.run(runId));
    this.db
      .prepare("INSERT OR IGNORE INTO tool_cache VALUES(?,?,?)")
      .run(runId, key, JSON.stringify(result));
  }
  memories(userId: string, role: Role | "orchestrator") {
    return this.db
      .prepare(
        "SELECT namespace,key,value,version,evidence,updated_at,expires_at FROM memories WHERE user_id=? AND namespace IN ('shared',?) AND retracted=0 AND (expires_at IS NULL OR expires_at>?) ORDER BY updated_at DESC LIMIT 40",
      )
      .all(userId, role, new Date().toISOString());
  }
  memoryHeads(userId: string, role?: Role | "orchestrator") {
    const rows = role
      ? this.db
          .prepare(
            "SELECT namespace,key,version,retracted,expires_at FROM memories WHERE user_id=? AND namespace IN ('shared',?) ORDER BY namespace,key",
          )
          .all(userId, role)
      : this.db
          .prepare(
            "SELECT namespace,key,version,retracted,expires_at FROM memories WHERE user_id=? ORDER BY namespace,key",
          )
          .all(userId);
    const now = new Date().toISOString();
    return rows.map((r) => ({
      namespace: String(r.namespace),
      key: String(r.key),
      version: Number(r.version),
      expiresAt: r.expires_at,
      state: r.retracted
        ? "retracted"
        : r.expires_at && String(r.expires_at) <= now
          ? "expired"
          : "active",
    }));
  }
  recallMemories(
    userId: string,
    role: Role | "orchestrator",
    input: z.input<typeof MemoryQuery> = {},
  ) {
    const rows = this.db
      .prepare(
        "SELECT namespace,key,value,version,evidence,updated_at,expires_at,retracted FROM memories WHERE user_id=? AND namespace IN ('shared',?)",
      )
      .all(userId, role);
    const now = new Date().toISOString();
    const memories: MemoryRow[] = rows.map((r) => ({
      namespace: String(r.namespace),
      key: String(r.key),
      value: String(r.value),
      version: Number(r.version),
      evidence: String(r.evidence),
      updated_at: String(r.updated_at),
      expires_at: r.expires_at ? String(r.expires_at) : null,
      state: r.retracted
        ? "retracted"
        : r.expires_at && String(r.expires_at) <= now
          ? "expired"
          : "active",
    }));
    return searchMemories(
      memories,
      input,
      hash([userId, role]),
      this.memorySignature(userId),
    );
  }
  memoryContext(userId: string, role: Role | "orchestrator", task: string) {
    const matches = this.recallMemories(userId, role, {
      query: task.slice(0, 2000),
      limit: 8,
    });
    return matches.items.length
      ? matches
      : this.recallMemories(userId, role, { limit: 8 });
  }
  memorySignature(userId: string) {
    return hash(this.memoryHeads(userId));
  }
  memoryHistory(userId: string) {
    return this.db
      .prepare(
        "SELECT body FROM memory_history WHERE user_id=? ORDER BY namespace,key,version",
      )
      .all(userId)
      .map((r) => JSON.parse(String(r.body)));
  }
  private writeMemory(
    userId: string,
    namespace: string,
    key: string,
    value: string,
    expectedVersion: number,
    source: string,
    evidenceIds: string[],
    operation: "upsert" | "retract",
    actor: string,
    reason: string,
    expiresAt?: string,
  ) {
    const existing = this.db
      .prepare(
        "SELECT version FROM memories WHERE user_id=? AND namespace=? AND key=?",
      )
      .get(userId, namespace, key);
    if (Number(existing?.version ?? 0) !== expectedVersion)
      throw new Error(`Memory version conflict: ${namespace}/${key}`);
    if (operation === "retract" && !existing)
      throw new Error("Cannot retract an unknown memory");
    if (operation === "upsert" && !value.trim())
      throw new Error("Memory value cannot be empty");
    if (expiresAt && expiresAt <= new Date().toISOString())
      throw new Error("Memory proposal already expired");
    const version = expectedVersion + 1,
      updatedAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO memories(user_id,namespace,key,value,version,source_run,evidence,expires_at,updated_at,retracted) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id,namespace,key) DO UPDATE SET value=excluded.value,version=excluded.version,source_run=excluded.source_run,evidence=excluded.evidence,expires_at=excluded.expires_at,updated_at=excluded.updated_at,retracted=excluded.retracted`,
      )
      .run(
        userId,
        namespace,
        key,
        operation === "retract" ? "" : value,
        version,
        source,
        JSON.stringify(evidenceIds),
        operation === "retract" ? null : (expiresAt ?? null),
        updatedAt,
        operation === "retract" ? 1 : 0,
      );
    const record = {
      userId,
      namespace,
      key,
      version,
      operation,
      actor,
      reason,
      value: operation === "retract" ? null : value,
      evidenceIds,
      source,
      expiresAt: expiresAt ?? null,
      updatedAt,
    };
    this.db
      .prepare("INSERT INTO memory_history VALUES(?,?,?,?,?)")
      .run(userId, namespace, key, version, JSON.stringify(record));
    return record;
  }
  changeMemory(userId: string, input: unknown) {
    if (!userId) throw new Error("User identity required");
    const change = MemoryChange.parse(input),
      requestHash = hash(change);
    return this.transaction(() => {
      const prior = this.db
        .prepare(
          "SELECT request_hash,result FROM memory_commands WHERE user_id=? AND operation_id=?",
        )
        .get(userId, change.operationId);
      if (prior) {
        if (prior.request_hash !== requestHash)
          throw new Error(
            "Operation ID already used for a different memory change",
          );
        return JSON.parse(String(prior.result));
      }
      const result = this.writeMemory(
        userId,
        change.namespace,
        change.key,
        change.operation === "correct" ? change.value : "",
        change.expectedVersion,
        `user:${change.operationId}`,
        [],
        change.operation === "correct" ? "upsert" : "retract",
        "user",
        change.reason,
        change.operation === "correct" ? change.expiresAt : undefined,
      );
      // A memory correction invalidates all live contexts of this user. Finished
      // traces remain audit data and are excluded from future artifact reuse.
      for (const run of this.listRuns(userId)) {
        if (
          ["created", "running", "waiting_approval", "failed"].includes(
            run.status,
          )
        ) {
          this.update(run.id, {
            status: "stale",
            error: "User corrected or retracted durable memory",
          });
          this.db
            .prepare(
              "UPDATE proposals SET status='superseded' WHERE run_id=? AND status='pending'",
            )
            .run(run.id);
          this.event(run.id, "memory.context_invalidated", {
            namespace: change.namespace,
            key: change.key,
            version: result.version,
            operationId: change.operationId,
          });
        }
      }
      this.db
        .prepare("INSERT INTO memory_commands VALUES(?,?,?,?)")
        .run(userId, change.operationId, requestHash, JSON.stringify(result));
      return result;
    });
  }
  propose(
    runId: string,
    input: z.input<typeof MemoryProposal>,
    origin?: { stepId: string; attempt: number },
  ): string {
    const proposal = MemoryProposal.parse(input);
    const id = hash(origin ? [runId, proposal, origin] : [runId, proposal]);
    this.transaction(() => {
      this.assertCurrent(this.run(runId));
      this.db
        .prepare(
          "INSERT OR IGNORE INTO proposals(id,run_id,body,origin) VALUES(?,?,?,?)",
        )
        .run(
          id,
          runId,
          JSON.stringify(proposal),
          origin ? JSON.stringify(origin) : null,
        );
    });
    return id;
  }
  proposals(runId: string) {
    return this.db
      .prepare("SELECT id,body,status,origin FROM proposals WHERE run_id=?")
      .all(runId)
      .map((r) => ({
        id: String(r.id),
        proposal: MemoryProposal.parse(JSON.parse(String(r.body))),
        status: String(r.status),
        origin: r.origin
          ? (JSON.parse(String(r.origin)) as {
              stepId: string;
              attempt: number;
            })
          : undefined,
      }));
  }
  commitMemories(runId: string) {
    return this.transaction(() => this.commitMemoryBatch(runId));
  }
  private commitMemoryBatch(runId: string) {
    const run = this.run(runId);
    this.assertCurrent(run);
    const pending = this.proposals(runId).filter((p) => p.status === "pending");
    for (const item of pending) {
      const p = item.proposal;
      if (item.origin) {
        const artifact = this.artifact(runId, item.origin.stepId);
        if (
          !artifact ||
          (artifact.attempt ?? 1) !== item.origin.attempt ||
          artifact.result.status === "failed"
        )
          throw new Error(
            "Memory proposal source attempt is not a valid current artifact",
          );
      }
      this.writeMemory(
        run.request.userId,
        p.namespace,
        p.key,
        p.value,
        p.expectedVersion,
        runId,
        p.evidenceIds,
        p.operation,
        "approved-proposal",
        "Explicit approval",
        p.expiresAt,
      );
      this.db
        .prepare("UPDATE proposals SET status='approved' WHERE id=?")
        .run(item.id);
    }
    if (pending.length)
      this.update(runId, {
        memorySnapshot: this.memorySignature(run.request.userId),
      });
  }
  approval(runId: string): ApprovalRecord | undefined {
    const row = this.db
      .prepare("SELECT body FROM approvals WHERE run_id=?")
      .get(runId);
    return row ? JSON.parse(String(row.body)) : undefined;
  }
  private approvalSnapshot(runId: string) {
    const run = this.run(runId);
    return {
      artifacts: this.artifacts(runId),
      proposals: this.proposals(runId).filter((p) => p.status === "pending"),
      constraintVersion: run.constraintVersion,
      memorySnapshot: run.memorySnapshot,
    };
  }
  prepareApproval(runId: string): ApprovalRecord {
    return this.transaction(() => {
      const previous = this.approval(runId);
      if (previous) return previous;
      this.assertCurrent(this.run(runId));
      const snapshot = this.approvalSnapshot(runId),
        snapshotHash = hash(snapshot);
      const record: ApprovalRecord = {
        approvalId: hash([runId, snapshotHash]),
        snapshotHash,
        artifactIds: snapshot.artifacts.map((a) => a.id),
        proposalIds: snapshot.proposals.map((p) => p.id),
        status: "pending",
      };
      this.db
        .prepare("INSERT INTO approvals VALUES(?,?)")
        .run(runId, JSON.stringify(record));
      this.putCache(runId, "approval-event", { approvalId: record.approvalId });
      this.event(runId, "approval.required", {
        ...record,
        memoryProposals: snapshot.proposals,
      });
      return record;
    });
  }
  decideApproval(
    runId: string,
    approvalId: string,
    decision: "approve" | "reject",
  ): ApprovalRecord {
    return this.transaction(() => {
      const record = this.approval(runId);
      if (!record || record.approvalId !== approvalId)
        throw new Error("Approval ID mismatch");
      if (record.status === "committed") {
        if (record.decision !== decision)
          throw new Error(
            "Approval already committed with a different decision",
          );
        return record;
      }
      this.assertCurrent(this.run(runId));
      if (record.snapshotHash !== hash(this.approvalSnapshot(runId)))
        throw new Error(
          "Approval snapshot changed; cannot commit stale approval",
        );
      if (decision === "approve") this.commitMemoryBatch(runId);
      else this.rejectMemories(runId);
      const committed: ApprovalRecord = {
        ...record,
        status: "committed",
        decision,
      };
      this.db
        .prepare("UPDATE approvals SET body=? WHERE run_id=?")
        .run(JSON.stringify(committed), runId);
      this.event(
        runId,
        decision === "approve" ? "memory.committed" : "approval.rejected",
        { approvalId, proposalIds: record.proposalIds },
      );
      return committed;
    });
  }
  rejectMemories(runId: string) {
    this.db
      .prepare(
        "UPDATE proposals SET status='rejected' WHERE run_id=? AND status='pending'",
      )
      .run(runId);
  }
  supersedeAttemptProposals(runId: string, stepId: string, attempt: number) {
    for (const p of this.proposals(runId))
      if (
        p.status === "pending" &&
        p.origin?.stepId === stepId &&
        p.origin.attempt === attempt
      )
        this.db
          .prepare("UPDATE proposals SET status='superseded' WHERE id=?")
          .run(p.id);
  }
  advanceConstraints(
    userId: string,
    conversationId: string,
    constraints: unknown,
  ): number {
    return this.transaction(() =>
      this.writeConstraints(userId, conversationId, constraints),
    );
  }
  private writeConstraints(
    userId: string,
    conversationId: string,
    constraints: unknown,
  ): number {
    const h = hash(constraints),
      row = this.db
        .prepare(
          "SELECT hash,version FROM constraints WHERE user_id=? AND conversation_id=?",
        )
        .get(userId, conversationId);
    if (row?.hash === h) return Number(row.version);
    const v = Number(row?.version ?? 0) + 1;
    this.db
      .prepare(
        "INSERT INTO constraints VALUES(?,?,?,?) ON CONFLICT(user_id,conversation_id) DO UPDATE SET hash=excluded.hash,version=excluded.version",
      )
      .run(userId, conversationId, h, v);
    return v;
  }
  assertCurrent(run: RunRecord) {
    this.assertLease(run.id);
    const current = this.run(run.id);
    if (["cancelled", "stale", "rejected"].includes(current.status))
      throw new Error(`Run ${current.status}`);
    if (
      (current.inputVersion ?? 0) !==
      this.inputVersion(run.request.userId, run.request.conversationId)
    ) {
      this.update(run.id, {
        status: "stale",
        error: "New user reply replaced the conversation input",
      });
      throw Error("Conversation input changed; discard stale result");
    }
    if (current.memorySnapshot !== this.memorySignature(run.request.userId)) {
      this.update(run.id, {
        status: "stale",
        error: "Durable memory changed or expired",
      });
      throw new Error(
        "Durable memory changed or expired; discard stale context",
      );
    }
    const row = this.db
      .prepare(
        "SELECT version FROM constraints WHERE user_id=? AND conversation_id=?",
      )
      .get(run.request.userId, run.request.conversationId);
    if (row && Number(row.version) !== run.constraintVersion) {
      this.update(run.id, { status: "stale" });
      throw new Error("Constraints changed; discard stale result");
    }
  }
  lease(resource: string, owner: string, ttlMs: number) {
    const result = this.db
      .prepare(
        "INSERT INTO leases VALUES(?,?,?) ON CONFLICT(resource) DO UPDATE SET owner=excluded.owner,expires=excluded.expires WHERE leases.expires<? OR leases.owner=excluded.owner",
      )
      .run(resource, owner, Date.now() + ttlMs, Date.now());
    if (!result.changes)
      throw new Error("Run is already executing in another process");
    this.ownedLeases.set(resource, owner);
  }
  ownsLease(resource: string, owner: string) {
    const row = this.db
      .prepare("SELECT owner,expires FROM leases WHERE resource=?")
      .get(resource);
    return row?.owner === owner && Number(row.expires) > Date.now();
  }
  assertLease(resource: string) {
    const owner = this.ownedLeases.get(resource);
    if (owner && !this.ownsLease(resource, owner))
      throw new Error("Execution lease lost; stale executor cannot commit");
  }
  renewLease(resource: string, owner: string, ttlMs: number) {
    const now = Date.now();
    const result = this.db
      .prepare(
        "UPDATE leases SET expires=? WHERE resource=? AND owner=? AND expires>?",
      )
      .run(now + ttlMs, resource, owner, now);
    if (!result.changes) throw new Error("Execution lease lost; cannot renew");
  }
  release(resource: string, owner: string) {
    this.db
      .prepare("DELETE FROM leases WHERE resource=? AND owner=?")
      .run(resource, owner);
    if (this.ownedLeases.get(resource) === owner)
      this.ownedLeases.delete(resource);
  }
  cancel(id: string, userId: string) {
    const r = this.run(id, userId);
    if (["succeeded", "rejected", "cancelled"].includes(r.status))
      throw new Error("Run is terminal");
    this.update(id, { status: "cancelled" });
    this.event(id, "run.cancelled", {});
  }
  // Deliberately erase associated private traces/checkpoints too; not just the visible memory row.
  forgetUser(userId: string) {
    const runs = this.listRuns(userId);
    if (runs.some((r) => r.status === "running"))
      throw new Error("Cancel active runs before erasing user data");
    if (
      runs.some(
        (r) =>
          Number(
            this.db
              .prepare("SELECT expires FROM leases WHERE resource=?")
              .get(r.id)?.expires ?? 0,
          ) > Date.now(),
      )
    )
      throw new Error(
        "Wait for active execution leases to release before erasing user data",
      );
    this.transaction(() => {
      for (const run of runs) {
        this.db.prepare("DELETE FROM leases WHERE resource=?").run(run.id);
        for (const table of [
          "events",
          "artifacts",
          "artifact_history",
          "proposals",
          "model_calls",
          "tool_cache",
          "approvals",
        ])
          this.db.prepare(`DELETE FROM ${table} WHERE run_id=?`).run(run.id);
        for (const table of ["checkpoints", "checkpoint_writes"])
          if (
            this.db
              .prepare("SELECT 1 FROM sqlite_master WHERE name=?")
              .get(table)
          )
            this.db
              .prepare(
                `DELETE FROM ${table} WHERE thread_id=? OR thread_id LIKE ?`,
              )
              .run(run.id, run.id + "::%");
      }
      this.db.prepare("DELETE FROM memories WHERE user_id=?").run(userId);
      this.db.prepare("DELETE FROM memory_history WHERE user_id=?").run(userId);
      this.db
        .prepare("DELETE FROM memory_commands WHERE user_id=?")
        .run(userId);
      this.db.prepare("DELETE FROM constraints WHERE user_id=?").run(userId);
      this.db
        .prepare("DELETE FROM conversation_inputs WHERE user_id=?")
        .run(userId);
      this.db
        .prepare("DELETE FROM follow_up_commands WHERE user_id=?")
        .run(userId);
      this.db.prepare("DELETE FROM runs WHERE user_id=?").run(userId);
    });
  }
}
