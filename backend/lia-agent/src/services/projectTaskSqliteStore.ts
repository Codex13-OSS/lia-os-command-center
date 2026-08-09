import { unlinkSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ProjectTaskRequest } from '../contracts/projectExecutor.js';
import { validateProjectTaskRequest } from '../contracts/projectExecutorValidation.js';
import type {
  CreateProjectTaskResult,
  ActiveTaskStage,
  ProjectTaskRecord,
  ProjectTaskReconciler,
  ProjectTaskStage,
  ProjectTaskStore,
  SafeTaskError,
  SafeTaskReceipt,
} from '../contracts/projectTask.js';
import { ACTIVE_TASK_STAGES, isActiveTaskCompletedStages, isSafeTaskStages, SAFE_TASK_ERROR_MESSAGES } from '../contracts/projectTask.js';
import {
  PROJECT_TASK_SQLITE_ERRORS,
  PROJECT_TASK_SQLITE_SCHEMA_VERSION,
  PROJECT_TASK_SQLITE_STAGES,
  initializeProjectTaskSqliteDatabaseV1,
  migrateProjectTaskSqliteDatabaseToCurrent,
} from './projectTaskSqliteSchema.js';

export type ProjectTaskSqliteStoreOptions = {
  databasePath: string;
  maxRecords?: number;
  maxActive?: number;
  terminalTtlMs?: number;
  now?: () => number;
};

type ResolvedProjectTaskSqliteStoreOptions = {
  databasePath: string;
  maxRecords: number;
  maxActive: number;
  terminalTtlMs: number;
  now?: () => number;
};

const STAGES = new Set<string>(PROJECT_TASK_SQLITE_STAGES);
const RECEIPT_STATUSES = new Set<string>(['analyzed', 'ready_for_review', 'verified', 'committed']);
const ERROR_STAGES = new Set<string>(['planning', 'hermes', 'approval', 'codex', 'verification', 'commit']);
const ACTIVE_STAGE_INDEX = new Map<string, number>(
  ACTIVE_TASK_STAGES.map((stage, index) => [stage, index]),
);

type ProjectTaskRow = {
  task_id: unknown;
  fingerprint: unknown;
  intent_json: unknown;
  status: unknown;
  created_at: unknown;
  updated_at: unknown;
  terminal_at: unknown;
  receipt_json: unknown;
  error_json: unknown;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0;

function isSafeTaskReceipt(value: unknown): value is SafeTaskReceipt {
  if (!isRecord(value)) return false;
  if (typeof value.executionId !== 'string' || value.executionId === '') return false;
  if (typeof value.status !== 'string' || !RECEIPT_STATUSES.has(value.status)) return false;
  if (typeof value.resultText !== 'string') return false;

  if (value.verification !== undefined) {
    if (!isRecord(value.verification) || value.verification.status !== 'verified') return false;
    const checksPassed = value.verification.checksPassed;
    const totalChecks = value.verification.totalChecks;
    if (!isNonNegativeInteger(checksPassed) || !isNonNegativeInteger(totalChecks)) return false;
    if (checksPassed > totalChecks) return false;
  }

  if (value.commit !== undefined && typeof value.commit !== 'string') return false;
  if (value.stages !== undefined && !isSafeTaskStages(value.stages)) return false;
  return true;
}

function isSafeTaskError(value: unknown): value is SafeTaskError {
  if (!isRecord(value)) return false;
  if (typeof value.code !== 'string' || !Object.hasOwn(SAFE_TASK_ERROR_MESSAGES, value.code)) return false;
  if (typeof value.message !== 'string' || value.message === '') return false;
  if (value.stage !== undefined && (typeof value.stage !== 'string' || !ERROR_STAGES.has(value.stage))) return false;
  if (value.projectId !== undefined && typeof value.projectId !== 'string') return false;
  if (value.executionId !== undefined && typeof value.executionId !== 'string') return false;
  if (value.completedStages !== undefined && !isSafeTaskStages(value.completedStages)) return false;
  return true;
}

/**
 * Durable ProjectTaskStore backed by node:sqlite.
 *
 * The store keeps one DatabaseSync connection open for its lifetime (the
 * interface is synchronous and the router calls it from a single-threaded
 * event loop, so per-operation open/close would only add cost and failure
 * points). Callers must invoke close() when the store is no longer needed;
 * every operation after close() fails closed.
 */
export class ProjectTaskSqliteStore implements ProjectTaskStore, ProjectTaskReconciler {
  private readonly options: ResolvedProjectTaskSqliteStoreOptions;
  private readonly database: DatabaseSync;
  private closed = false;

  constructor(options: ProjectTaskSqliteStoreOptions) {
    const { databasePath } = options;
    if (!isAbsolute(databasePath) || databasePath.includes('\0')) {
      throw new Error(PROJECT_TASK_SQLITE_ERRORS.invalidPath);
    }

    this.options = { maxRecords: 200, maxActive: 8, terminalTtlMs: 86_400_000, ...options };

    // Bootstrap a missing file privately (0600) with the versioned schema.
    // An existing file is left untouched and validated strictly instead.
    let created = false;
    try {
      initializeProjectTaskSqliteDatabaseV1(databasePath);
      created = true;
    } catch (error) {
      if (!(error instanceof Error && error.message === PROJECT_TASK_SQLITE_ERRORS.alreadyExists)) {
        throw error;
      }
    }

    let database: DatabaseSync;
    try {
      database = new DatabaseSync(databasePath);
    } catch (error) {
      if (created) {
        try {
          unlinkSync(databasePath);
        } catch {
          // Preserve the original initialization error.
        }
      }
      throw new Error(PROJECT_TASK_SQLITE_ERRORS.schema);
    }

    this.database = database;

    try {
      migrateProjectTaskSqliteDatabaseToCurrent(this.database);
      this.assertSchemaCompatible();
    } catch (error) {
      try {
        this.database.close();
      } catch {
        // Preserve the original initialization error.
      }

      if (created) {
        try {
          unlinkSync(databasePath);
        } catch {
          // Preserve the original initialization error.
        }
      }

      throw error;
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private requireOpen(): void {
    if (this.closed) {
      throw new Error(PROJECT_TASK_SQLITE_ERRORS.closed);
    }
  }

  private assertSchemaCompatible(): void {
    let metaRows: Array<{ singleton: unknown; schema_version: unknown }>;
    try {
      metaRows = this.database
        .prepare('SELECT singleton, schema_version FROM project_task_meta WHERE singleton = 1')
        .all() as unknown as typeof metaRows;
    } catch {
      throw new Error(PROJECT_TASK_SQLITE_ERRORS.schema);
    }

    if (metaRows.length !== 1) {
      throw new Error(PROJECT_TASK_SQLITE_ERRORS.schema);
    }

    const [meta] = metaRows;
    if (meta.singleton !== 1 || meta.schema_version !== PROJECT_TASK_SQLITE_SCHEMA_VERSION) {
      throw new Error(PROJECT_TASK_SQLITE_ERRORS.schema);
    }

    try {
      this.database.prepare('SELECT task_id FROM project_tasks LIMIT 1').all();
      this.database.prepare(
        'SELECT task_id, completed_stages_json FROM project_task_active_stage_traces LIMIT 1',
      ).all();
    } catch {
      throw new Error(PROJECT_TASK_SQLITE_ERRORS.schema);
    }
  }

  private inTransaction<T>(operation: () => T): T {
    this.requireOpen();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.database.exec('ROLLBACK');
      } catch {
        // Preserve the original error.
      }
      throw error;
    }
  }

  private pruneExpiredTerminals(): void {
    this.database.prepare(`
      DELETE FROM project_tasks
      WHERE terminal_at IS NOT NULL
        AND ? - terminal_at >= ?
    `).run(this.now(), this.options.terminalTtlMs);

    this.database.prepare(`
      DELETE FROM project_task_active_stage_traces
      WHERE task_id NOT IN (SELECT task_id FROM project_tasks)
    `).run();
  }

  private selectRow(taskId: string): ProjectTaskRow | undefined {
    return this.database.prepare(`
      SELECT task_id, fingerprint, intent_json, status, created_at, updated_at, terminal_at, receipt_json, error_json
      FROM project_tasks
      WHERE task_id = ?
    `).get(taskId) as unknown as ProjectTaskRow | undefined;
  }

  private selectActiveCompletedStages(taskId: string): readonly ActiveTaskStage[] {
    const trace = this.database.prepare(`
      SELECT completed_stages_json
      FROM project_task_active_stage_traces
      WHERE task_id = ?
    `).get(taskId) as unknown as { completed_stages_json: unknown } | undefined;

    if (trace === undefined) return [];
    if (typeof trace.completed_stages_json !== 'string') {
      throw new Error(PROJECT_TASK_SQLITE_ERRORS.corruptRecord);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(trace.completed_stages_json);
    } catch {
      throw new Error(PROJECT_TASK_SQLITE_ERRORS.corruptRecord);
    }

    if (!isActiveTaskCompletedStages(parsed)) {
      throw new Error(PROJECT_TASK_SQLITE_ERRORS.corruptRecord);
    }

    return parsed;
  }

  private decodeRow(row: ProjectTaskRow): ProjectTaskRecord {
    const corrupt = (): Error => new Error(PROJECT_TASK_SQLITE_ERRORS.corruptRecord);

    if (typeof row.task_id !== 'string' || row.task_id === '') throw corrupt();
    if (typeof row.fingerprint !== 'string' || row.fingerprint === '') throw corrupt();
    if (typeof row.intent_json !== 'string') throw corrupt();
    if (typeof row.status !== 'string' || !STAGES.has(row.status)) throw corrupt();
    if (!isNonNegativeInteger(row.created_at) || !isNonNegativeInteger(row.updated_at)) throw corrupt();
    if (row.terminal_at !== null && !isNonNegativeInteger(row.terminal_at)) throw corrupt();
    if (row.receipt_json !== null && typeof row.receipt_json !== 'string') throw corrupt();
    if (row.error_json !== null && typeof row.error_json !== 'string') throw corrupt();

    const activeCompletedStages = this.selectActiveCompletedStages(row.task_id);

    // Active durable evidence must always describe stages strictly earlier
    // than the current active status. Accepted/terminal rows must not retain
    // a transient sidecar trace.
    if (activeCompletedStages.length > 0) {
      const currentStageIndex = ACTIVE_STAGE_INDEX.get(row.status);
      const lastCompletedStage = activeCompletedStages.at(-1);
      const lastCompletedIndex = lastCompletedStage === undefined
        ? undefined
        : ACTIVE_STAGE_INDEX.get(lastCompletedStage);

      if (
        currentStageIndex === undefined
        || lastCompletedIndex === undefined
        || lastCompletedIndex >= currentStageIndex
      ) {
        throw corrupt();
      }
    }

    let intent: unknown;
    try {
      intent = JSON.parse(row.intent_json);
    } catch {
      throw corrupt();
    }
    const intentValidation = validateProjectTaskRequest(intent);
    if (!intentValidation.success) throw corrupt();

    let receipt: SafeTaskReceipt | undefined;
    if (row.receipt_json !== null) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.receipt_json);
      } catch {
        throw corrupt();
      }
      if (!isSafeTaskReceipt(parsed)) throw corrupt();
      receipt = parsed;
    }

    let error: SafeTaskError | undefined;
    if (row.error_json !== null) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.error_json);
      } catch {
        throw corrupt();
      }
      if (!isSafeTaskError(parsed)) throw corrupt();
      error = parsed;
    }

    const terminalAt = row.terminal_at === null ? undefined : row.terminal_at;
    const terminal = row.status === 'completed' || row.status === 'failed';
    if (terminal !== (terminalAt !== undefined)) throw corrupt();
    if (row.status === 'completed' && (receipt === undefined || error !== undefined)) throw corrupt();
    if (row.status === 'failed' && (error === undefined || receipt !== undefined)) throw corrupt();
    if (terminalAt === undefined && (receipt !== undefined || error !== undefined)) throw corrupt();

    return {
      taskId: row.task_id,
      fingerprint: row.fingerprint,
      intent: intentValidation.request,
      status: row.status as ProjectTaskStage,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(activeCompletedStages.length > 0 ? { completedStages: activeCompletedStages } : {}),
      ...(terminalAt !== undefined ? { terminalAt } : {}),
      ...(receipt !== undefined ? { receipt } : {}),
      ...(error !== undefined ? { error } : {}),
    };
  }

  createOrGet(taskId: string, fingerprint: string, intent: ProjectTaskRequest): CreateProjectTaskResult {
    return this.inTransaction(() => {
      this.pruneExpiredTerminals();

      const existing = this.selectRow(taskId);
      if (existing !== undefined) {
        const record = this.decodeRow(existing);
        return existing.fingerprint === fingerprint
          ? { kind: 'known', record }
          : { kind: 'conflict' };
      }

      const counts = this.database.prepare(`
        SELECT COUNT(*) AS total, SUM(CASE WHEN terminal_at IS NULL THEN 1 ELSE 0 END) AS active
        FROM project_tasks
      `).get() as unknown as { total: number; active: number | null };

      const total = counts.total;
      const active = counts.active ?? 0;
      if (total >= this.options.maxRecords || active >= this.options.maxActive) {
        return { kind: 'capacity' };
      }

      const now = this.now();
      const record: ProjectTaskRecord = {
        taskId,
        fingerprint,
        intent,
        status: 'accepted',
        createdAt: now,
        updatedAt: now,
      };
      this.database.prepare(`
        INSERT INTO project_tasks (task_id, fingerprint, intent_json, status, created_at, updated_at)
        VALUES (?, ?, ?, 'accepted', ?, ?)
      `).run(taskId, fingerprint, JSON.stringify(intent), now, now);
      return { kind: 'created', record };
    });
  }

  get(taskId: string): ProjectTaskRecord | undefined {
    return this.inTransaction(() => {
      this.pruneExpiredTerminals();
      const row = this.selectRow(taskId);
      return row === undefined ? undefined : this.decodeRow(row);
    });
  }

  transition(taskId: string, status: Exclude<ProjectTaskStage, 'accepted' | 'completed' | 'failed'>): void {
    this.inTransaction(() => {
      this.pruneExpiredTerminals();
      const row = this.selectRow(taskId);
      if (row === undefined || row.terminal_at !== null) return;

      const current = this.decodeRow(row);
      let completedStages = [...(current.completedStages ?? [])];
      const currentIndex = ACTIVE_STAGE_INDEX.get(current.status);
      const nextIndex = ACTIVE_STAGE_INDEX.get(status);

      // Delayed/out-of-order observations may never move durable state
      // backwards. Keeping the latest confirmed boundary also keeps the
      // completed-stage evidence semantically consistent.
      if (
        currentIndex !== undefined
        && nextIndex !== undefined
        && nextIndex < currentIndex
      ) {
        return;
      }

      // A stage becomes durably complete only when a later observed stage
      // supersedes it. Canonical gaps remain gaps; they are never filled in.
      if (
        current.status !== status
        && currentIndex !== undefined
        && nextIndex !== undefined
        && currentIndex < nextIndex
      ) {
        const last = completedStages.at(-1);
        const lastIndex = last === undefined ? -1 : (ACTIVE_STAGE_INDEX.get(last) ?? -1);
        if (currentIndex > lastIndex) {
          const observed = ACTIVE_TASK_STAGES.find((stage) => stage === current.status);
          if (observed !== undefined) completedStages = [...completedStages, observed];
        }
      }

      if (!isActiveTaskCompletedStages(completedStages)) {
        throw new Error(PROJECT_TASK_SQLITE_ERRORS.corruptRecord);
      }

      const now = this.now();
      this.database.prepare(`
        UPDATE project_tasks
        SET status = ?, updated_at = ?
        WHERE task_id = ?
      `).run(status, now, taskId);

      if (completedStages.length > 0) {
        this.database.prepare(`
          INSERT INTO project_task_active_stage_traces (task_id, completed_stages_json)
          VALUES (?, ?)
          ON CONFLICT(task_id) DO UPDATE
          SET completed_stages_json = excluded.completed_stages_json
        `).run(taskId, JSON.stringify(completedStages));
      }
    });
  }

  complete(taskId: string, receipt: SafeTaskReceipt): void {
    this.inTransaction(() => {
      this.pruneExpiredTerminals();
      const row = this.selectRow(taskId);
      if (row === undefined || row.terminal_at !== null) return;
      const now = this.now();
      this.database.prepare(`
        UPDATE project_tasks
        SET status = 'completed', receipt_json = ?, updated_at = ?, terminal_at = ?
        WHERE task_id = ?
      `).run(JSON.stringify(receipt), now, now, taskId);

      this.database.prepare(
        'DELETE FROM project_task_active_stage_traces WHERE task_id = ?',
      ).run(taskId);
    });
  }

  fail(taskId: string, error: SafeTaskError): void {
    this.inTransaction(() => {
      this.pruneExpiredTerminals();
      const row = this.selectRow(taskId);
      if (row === undefined || row.terminal_at !== null) return;
      const now = this.now();
      this.database.prepare(`
        UPDATE project_tasks
        SET status = 'failed', error_json = ?, updated_at = ?, terminal_at = ?
        WHERE task_id = ?
      `).run(JSON.stringify(error), now, now, taskId);

      this.database.prepare(
        'DELETE FROM project_task_active_stage_traces WHERE task_id = ?',
      ).run(taskId);
    });
  }

  /**
   * Atomically marks every task that survived a service restart without
   * reaching a terminal stage as failed with the workflow_interrupted error.
   *
   * Identity fields (task_id, fingerprint, intent_json, created_at) are
   * preserved; updated_at/terminal_at become now; any inconsistent receipt is
   * cleared. The operation is idempotent: already-terminal tasks (completed or
   * failed) are never touched and their timestamps stay unchanged.
   */
  reconcileInterruptedTasks(): number {
    return this.inTransaction(() => {
      const now = this.now();
      const interrupted: SafeTaskError = {
        code: 'workflow_interrupted',
        message: SAFE_TASK_ERROR_MESSAGES.workflow_interrupted,
      };
      const result = this.database.prepare(`
        UPDATE project_tasks
        SET status = 'failed',
            error_json = ?,
            receipt_json = NULL,
            updated_at = ?,
            terminal_at = ?
        WHERE status NOT IN ('completed', 'failed')
      `).run(JSON.stringify(interrupted), now, now);

      this.database.prepare(`
        DELETE FROM project_task_active_stage_traces
        WHERE task_id NOT IN (
          SELECT task_id
          FROM project_tasks
          WHERE terminal_at IS NULL
        )
      `).run();

      return Number(result.changes);
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }
}
