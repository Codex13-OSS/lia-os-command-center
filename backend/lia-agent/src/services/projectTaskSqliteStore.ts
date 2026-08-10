import { unlinkSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ProjectTaskRequest } from '../contracts/projectExecutor.js';
import { validateProjectTaskRequest } from '../contracts/projectExecutorValidation.js';
import type {
  CreateContinuationAttemptInput,
  CreateProjectGoalInput,
  CreateRootAttemptInput,
  ProjectGoalRecord,
  ProjectGoalStore,
  ProjectGoalTerminalReason,
  ProjectGoalTerminalStatus,
} from '../contracts/projectGoal.js';
import {
  PROJECT_GOAL_CONTINUATION_DEPTH_LIMIT,
  PROJECT_GOAL_DEFAULT_CONTINUATION_DEPTH_LIMIT,
  PROJECT_GOAL_DEFAULT_MAX_ATTEMPTS,
  PROJECT_GOAL_ERRORS,
  PROJECT_GOAL_ID,
  PROJECT_GOAL_MAX_ATTEMPTS_LIMIT,
  PROJECT_GOAL_STATUSES,
  PROJECT_GOAL_TERMINAL_REASONS,
} from '../contracts/projectGoal.js';
import type {
  CreateProjectTaskResult,
  ActiveTaskStage,
  ProjectTaskRecord,
  ProjectTaskReconciler,
  ProjectTaskLineage,
  ProjectTaskStage,
  ProjectTaskStore,
  SafeTaskError,
  SafeTaskReceipt,
} from '../contracts/projectTask.js';
import { ACTIVE_TASK_STAGES, isActiveTaskCompletedStages, isSafeTaskStages, PROJECT_TASK_ID, SAFE_TASK_ERROR_MESSAGES } from '../contracts/projectTask.js';
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
const GOAL_STATUSES = new Set<string>(PROJECT_GOAL_STATUSES);
const GOAL_TERMINAL_REASONS = new Set<string>(PROJECT_GOAL_TERMINAL_REASONS);

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

type ProjectGoalRow = {
  goal_id: unknown;
  project_id: unknown;
  objective: unknown;
  status: unknown;
  created_at: unknown;
  updated_at: unknown;
  terminal_at: unknown;
  current_attempt: unknown;
  max_attempts: unknown;
  continuation_depth_limit: unknown;
  terminal_reason: unknown;
};

type ProjectTaskLineageRow = {
  task_id: unknown;
  goal_id: unknown;
  parent_task_id: unknown;
  continuation_depth: unknown;
  attempt_number: unknown;
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
export class ProjectTaskSqliteStore implements ProjectTaskStore, ProjectTaskReconciler, ProjectGoalStore {
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
      this.database.exec('PRAGMA foreign_keys = ON');
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
      this.database.prepare('SELECT goal_id FROM project_goals LIMIT 1').all();
      this.database.prepare(
        'SELECT task_id, goal_id, parent_task_id, continuation_depth, attempt_number FROM project_task_lineage LIMIT 1',
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
        AND task_id NOT IN (SELECT task_id FROM project_task_lineage)
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

  private selectGoalRow(goalId: string): ProjectGoalRow | undefined {
    return this.database.prepare(`
      SELECT goal_id, project_id, objective, status, created_at, updated_at, terminal_at,
             current_attempt, max_attempts, continuation_depth_limit, terminal_reason
      FROM project_goals WHERE goal_id = ?
    `).get(goalId) as unknown as ProjectGoalRow | undefined;
  }

  private decodeGoalRow(row: ProjectGoalRow): ProjectGoalRecord {
    const corrupt = (): Error => new Error(PROJECT_TASK_SQLITE_ERRORS.corruptRecord);
    if (typeof row.goal_id !== 'string' || !PROJECT_GOAL_ID.test(row.goal_id)) throw corrupt();
    if (typeof row.project_id !== 'string' || row.project_id === '') throw corrupt();
    if (typeof row.objective !== 'string' || row.objective.length === 0 || row.objective.length > 20_000) throw corrupt();
    if (typeof row.status !== 'string' || !GOAL_STATUSES.has(row.status)) throw corrupt();
    if (!isNonNegativeInteger(row.created_at) || !isNonNegativeInteger(row.updated_at) || row.updated_at < row.created_at) throw corrupt();
    if (row.terminal_at !== null && (!isNonNegativeInteger(row.terminal_at) || row.terminal_at < row.created_at)) throw corrupt();
    if (row.current_attempt !== null && !isNonNegativeInteger(row.current_attempt)) throw corrupt();
    if (!isNonNegativeInteger(row.max_attempts) || row.max_attempts < 1 || row.max_attempts > PROJECT_GOAL_MAX_ATTEMPTS_LIMIT) throw corrupt();
    if (!isNonNegativeInteger(row.continuation_depth_limit) || row.continuation_depth_limit > PROJECT_GOAL_CONTINUATION_DEPTH_LIMIT) throw corrupt();
    if (row.terminal_reason !== null && (typeof row.terminal_reason !== 'string' || !GOAL_TERMINAL_REASONS.has(row.terminal_reason))) throw corrupt();

    const terminal = row.status !== 'active';
    if (terminal !== (row.terminal_at !== null) || terminal !== (row.terminal_reason !== null)) throw corrupt();
    const expectedReasonByStatus: Partial<Record<ProjectGoalRecord['status'], ProjectGoalTerminalReason>> = {
      completed: 'objective_completed',
      blocked: 'human_intervention_required',
      exhausted: 'attempt_limit_reached',
      failed: 'unrecoverable_failure',
    };
    if (terminal && row.terminal_reason !== expectedReasonByStatus[row.status as ProjectGoalRecord['status']]) throw corrupt();
    if (row.current_attempt !== null && row.current_attempt >= row.max_attempts) throw corrupt();

    const attempt = this.database.prepare(`
      SELECT MAX(attempt_number) AS latest, COUNT(*) AS total
      FROM project_task_lineage WHERE goal_id = ?
    `).get(row.goal_id) as unknown as { latest: unknown; total: unknown };
    if (!isNonNegativeInteger(attempt.total)) throw corrupt();
    const expectedCurrent = attempt.total === 0 ? null : attempt.latest;
    if (expectedCurrent !== row.current_attempt || attempt.total > row.max_attempts) throw corrupt();

    return {
      goalId: row.goal_id,
      projectId: row.project_id,
      objective: row.objective,
      status: row.status as ProjectGoalRecord['status'],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      currentAttempt: row.current_attempt,
      maxAttempts: row.max_attempts,
      continuationDepthLimit: row.continuation_depth_limit,
      ...(row.terminal_at !== null ? { terminalAt: row.terminal_at } : {}),
      ...(row.terminal_reason !== null
        ? { terminalReason: row.terminal_reason as ProjectGoalTerminalReason }
        : {}),
    };
  }

  private selectLineageRow(taskId: string): ProjectTaskLineageRow | undefined {
    return this.database.prepare(`
      SELECT task_id, goal_id, parent_task_id, continuation_depth, attempt_number
      FROM project_task_lineage WHERE task_id = ?
    `).get(taskId) as unknown as ProjectTaskLineageRow | undefined;
  }

  private decodeLineage(taskId: string, taskProjectId: string): ProjectTaskLineage | undefined {
    const first = this.selectLineageRow(taskId);
    if (first === undefined) return undefined;
    const corrupt = (): Error => new Error(PROJECT_TASK_SQLITE_ERRORS.corruptRecord);
    const seen = new Set<string>();
    let cursor: ProjectTaskLineageRow | undefined = first;
    let expectedDepth: number | undefined;
    let expectedAttempt: number | undefined;
    let goalId: string | undefined;

    while (cursor !== undefined) {
      if (typeof cursor.task_id !== 'string' || seen.has(cursor.task_id)) throw corrupt();
      if (typeof cursor.goal_id !== 'string' || cursor.goal_id === '') throw corrupt();
      if (cursor.parent_task_id !== null && typeof cursor.parent_task_id !== 'string') throw corrupt();
      if (!isNonNegativeInteger(cursor.continuation_depth) || !isNonNegativeInteger(cursor.attempt_number)) throw corrupt();
      if (cursor.task_id === cursor.parent_task_id) throw corrupt();
      if (goalId !== undefined && cursor.goal_id !== goalId) throw corrupt();
      if (expectedDepth !== undefined && cursor.continuation_depth !== expectedDepth) throw corrupt();
      if (expectedAttempt !== undefined && cursor.attempt_number !== expectedAttempt) throw corrupt();
      seen.add(cursor.task_id);
      goalId = cursor.goal_id;

      const project = this.database.prepare(`
        SELECT json_extract(intent_json, '$.projectId') AS project_id
        FROM project_tasks WHERE task_id = ?
      `).get(cursor.task_id) as unknown as { project_id: unknown } | undefined;
      if (project?.project_id !== taskProjectId) throw corrupt();

      if (cursor.parent_task_id === null) {
        if (cursor.continuation_depth !== 0 || cursor.attempt_number !== 0) throw corrupt();
        break;
      }
      expectedDepth = cursor.continuation_depth - 1;
      expectedAttempt = cursor.attempt_number - 1;
      cursor = this.selectLineageRow(cursor.parent_task_id);
      if (cursor === undefined) throw corrupt();
    }

    if (goalId === undefined) throw corrupt();
    const goalRow = this.selectGoalRow(goalId);
    if (goalRow === undefined) throw corrupt();
    const goal = this.decodeGoalRow(goalRow);
    if (goal.projectId !== taskProjectId) throw corrupt();
    if (!isNonNegativeInteger(first.continuation_depth) || !isNonNegativeInteger(first.attempt_number)) throw corrupt();
    if (first.attempt_number > (goal.currentAttempt ?? -1) || first.attempt_number >= goal.maxAttempts) throw corrupt();
    if (first.continuation_depth > goal.continuationDepthLimit) throw corrupt();

    return {
      goalId,
      ...(typeof first.parent_task_id === 'string' ? { parentTaskId: first.parent_task_id } : {}),
      continuationDepth: first.continuation_depth,
      attemptNumber: first.attempt_number,
    };
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
    const lineage = this.decodeLineage(row.task_id, intentValidation.request.projectId);

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
      ...(lineage !== undefined ? { lineage } : {}),
      ...(terminalAt !== undefined ? { terminalAt } : {}),
      ...(receipt !== undefined ? { receipt } : {}),
      ...(error !== undefined ? { error } : {}),
    };
  }

  createGoal(input: CreateProjectGoalInput): ProjectGoalRecord {
    return this.inTransaction(() => {
      const maxAttempts = input.maxAttempts ?? PROJECT_GOAL_DEFAULT_MAX_ATTEMPTS;
      const continuationDepthLimit = input.continuationDepthLimit
        ?? PROJECT_GOAL_DEFAULT_CONTINUATION_DEPTH_LIMIT;
      if (
        !PROJECT_GOAL_ID.test(input.goalId)
        || typeof input.projectId !== 'string'
        || input.projectId.trim() === ''
        || typeof input.objective !== 'string'
        || input.objective.trim() === ''
        || input.objective.length > 20_000
        || !Number.isInteger(maxAttempts)
        || maxAttempts < 1
        || maxAttempts > PROJECT_GOAL_MAX_ATTEMPTS_LIMIT
        || !Number.isInteger(continuationDepthLimit)
        || continuationDepthLimit < 0
        || continuationDepthLimit > PROJECT_GOAL_CONTINUATION_DEPTH_LIMIT
      ) {
        throw new Error(PROJECT_GOAL_ERRORS.invalidGoal);
      }
      if (this.selectGoalRow(input.goalId) !== undefined) {
        throw new Error(PROJECT_GOAL_ERRORS.goalExists);
      }

      const now = this.now();
      this.database.prepare(`
        INSERT INTO project_goals (
          goal_id, project_id, objective, status, created_at, updated_at,
          current_attempt, max_attempts, continuation_depth_limit
        ) VALUES (?, ?, ?, 'active', ?, ?, NULL, ?, ?)
      `).run(
        input.goalId,
        input.projectId,
        input.objective,
        now,
        now,
        maxAttempts,
        continuationDepthLimit,
      );
      const row = this.selectGoalRow(input.goalId);
      if (row === undefined) throw new Error(PROJECT_TASK_SQLITE_ERRORS.corruptRecord);
      return this.decodeGoalRow(row);
    });
  }

  readGoal(goalId: string): ProjectGoalRecord | undefined {
    return this.inTransaction(() => {
      const row = this.selectGoalRow(goalId);
      return row === undefined ? undefined : this.decodeGoalRow(row);
    });
  }

  private createGoalAttempt(
    input: CreateRootAttemptInput | CreateContinuationAttemptInput,
  ): CreateProjectTaskResult {
    return this.inTransaction(() => {
      this.pruneExpiredTerminals();
      if (
        !PROJECT_TASK_ID.test(input.taskId)
        || !PROJECT_GOAL_ID.test(input.goalId)
        || typeof input.fingerprint !== 'string'
        || input.fingerprint === ''
        || !isNonNegativeInteger(input.continuationDepth)
        || !isNonNegativeInteger(input.attemptNumber)
      ) {
        throw new Error(PROJECT_GOAL_ERRORS.invalidLineage);
      }
      const intentValidation = validateProjectTaskRequest(input.intent);
      if (!intentValidation.success) throw new Error(PROJECT_GOAL_ERRORS.invalidLineage);

      const goalRow = this.selectGoalRow(input.goalId);
      if (goalRow === undefined) throw new Error(PROJECT_GOAL_ERRORS.goalNotFound);
      const goal = this.decodeGoalRow(goalRow);
      if (goal.status !== 'active') throw new Error(PROJECT_GOAL_ERRORS.goalTerminal);
      if (intentValidation.request.projectId !== goal.projectId) {
        throw new Error(PROJECT_GOAL_ERRORS.parentProjectMismatch);
      }

      const parentTaskId = 'parentTaskId' in input ? input.parentTaskId : undefined;
      if (parentTaskId === input.taskId) throw new Error(PROJECT_GOAL_ERRORS.invalidLineage);

      const existing = this.selectRow(input.taskId);
      if (existing !== undefined) {
        const record = this.decodeRow(existing);
        if (existing.fingerprint !== input.fingerprint) return { kind: 'conflict' };
        const expectedParent = 'parentTaskId' in input ? input.parentTaskId : undefined;
        if (
          record.lineage?.goalId !== input.goalId
          || record.lineage.parentTaskId !== expectedParent
          || record.lineage.continuationDepth !== input.continuationDepth
          || record.lineage.attemptNumber !== input.attemptNumber
        ) {
          throw new Error(PROJECT_GOAL_ERRORS.lineageImmutable);
        }
        return { kind: 'known', record };
      }

      if (parentTaskId === undefined) {
        if (input.continuationDepth !== 0 || input.attemptNumber !== 0 || goal.currentAttempt !== null) {
          throw new Error(PROJECT_GOAL_ERRORS.invalidLineage);
        }
      } else {
        const parentRow = this.selectRow(parentTaskId);
        if (parentRow === undefined) throw new Error(PROJECT_GOAL_ERRORS.parentNotFound);
        const parent = this.decodeRow(parentRow);
        if (parent.intent.projectId !== intentValidation.request.projectId) {
          throw new Error(PROJECT_GOAL_ERRORS.parentProjectMismatch);
        }
        if (parent.lineage?.goalId !== input.goalId) {
          throw new Error(PROJECT_GOAL_ERRORS.parentGoalMismatch);
        }
        if (
          input.continuationDepth !== parent.lineage.continuationDepth + 1
          || input.attemptNumber !== parent.lineage.attemptNumber + 1
          || parent.lineage.attemptNumber !== goal.currentAttempt
        ) {
          throw new Error(PROJECT_GOAL_ERRORS.invalidLineage);
        }
        const parentCapabilities = new Set(parent.intent.requestedCapabilities);
        if (intentValidation.request.requestedCapabilities.some((capability) => !parentCapabilities.has(capability))) {
          throw new Error(PROJECT_GOAL_ERRORS.capabilityExpansion);
        }
      }

      if (input.attemptNumber >= goal.maxAttempts) {
        throw new Error(PROJECT_GOAL_ERRORS.attemptLimit);
      }
      if (input.continuationDepth > goal.continuationDepthLimit) {
        throw new Error(PROJECT_GOAL_ERRORS.depthLimit);
      }

      const counts = this.database.prepare(`
        SELECT COUNT(*) AS total, SUM(CASE WHEN terminal_at IS NULL THEN 1 ELSE 0 END) AS active
        FROM project_tasks
      `).get() as unknown as { total: number; active: number | null };
      if (counts.total >= this.options.maxRecords || (counts.active ?? 0) >= this.options.maxActive) {
        return { kind: 'capacity' };
      }

      const now = this.now();
      this.database.prepare(`
        INSERT INTO project_tasks (task_id, fingerprint, intent_json, status, created_at, updated_at)
        VALUES (?, ?, ?, 'accepted', ?, ?)
      `).run(input.taskId, input.fingerprint, JSON.stringify(intentValidation.request), now, now);
      this.database.prepare(`
        INSERT INTO project_task_lineage (
          task_id, goal_id, parent_task_id, continuation_depth, attempt_number
        ) VALUES (?, ?, ?, ?, ?)
      `).run(
        input.taskId,
        input.goalId,
        parentTaskId ?? null,
        input.continuationDepth,
        input.attemptNumber,
      );
      this.database.prepare('UPDATE project_goals SET updated_at = ? WHERE goal_id = ?')
        .run(now, input.goalId);

      const row = this.selectRow(input.taskId);
      if (row === undefined) throw new Error(PROJECT_TASK_SQLITE_ERRORS.corruptRecord);
      return { kind: 'created', record: this.decodeRow(row) };
    });
  }

  createRootAttempt(input: CreateRootAttemptInput): CreateProjectTaskResult {
    return this.createGoalAttempt(input);
  }

  createContinuationAttempt(input: CreateContinuationAttemptInput): CreateProjectTaskResult {
    return this.createGoalAttempt(input);
  }

  listGoalAttempts(goalId: string): ProjectTaskRecord[] {
    return this.inTransaction(() => {
      const goal = this.selectGoalRow(goalId);
      if (goal === undefined) throw new Error(PROJECT_GOAL_ERRORS.goalNotFound);
      this.decodeGoalRow(goal);
      const rows = this.database.prepare(`
        SELECT t.task_id, t.fingerprint, t.intent_json, t.status, t.created_at, t.updated_at,
               t.terminal_at, t.receipt_json, t.error_json
        FROM project_task_lineage AS l
        JOIN project_tasks AS t ON t.task_id = l.task_id
        WHERE l.goal_id = ?
        ORDER BY l.attempt_number ASC, t.created_at ASC, t.task_id ASC
      `).all(goalId) as unknown as ProjectTaskRow[];
      return rows.map((row) => this.decodeRow(row));
    });
  }

  transitionGoal(
    goalId: string,
    status: ProjectGoalTerminalStatus,
    terminalReason?: ProjectGoalTerminalReason,
  ): ProjectGoalRecord {
    return this.inTransaction(() => {
      const row = this.selectGoalRow(goalId);
      if (row === undefined) throw new Error(PROJECT_GOAL_ERRORS.goalNotFound);
      const goal = this.decodeGoalRow(row);
      if (goal.status !== 'active') throw new Error(PROJECT_GOAL_ERRORS.invalidTransition);
      const expectedReasons: Record<ProjectGoalTerminalStatus, ProjectGoalTerminalReason> = {
        completed: 'objective_completed',
        blocked: 'human_intervention_required',
        exhausted: 'attempt_limit_reached',
        failed: 'unrecoverable_failure',
      };
      if (!Object.hasOwn(expectedReasons, status)) throw new Error(PROJECT_GOAL_ERRORS.invalidTransition);
      const reason = terminalReason ?? expectedReasons[status];
      if (reason !== expectedReasons[status]) throw new Error(PROJECT_GOAL_ERRORS.invalidTransition);
      const now = this.now();
      this.database.prepare(`
        UPDATE project_goals
        SET status = ?, terminal_reason = ?, updated_at = ?, terminal_at = ?
        WHERE goal_id = ? AND status = 'active'
      `).run(status, reason, now, now, goalId);
      const terminal = this.selectGoalRow(goalId);
      if (terminal === undefined) throw new Error(PROJECT_TASK_SQLITE_ERRORS.corruptRecord);
      return this.decodeGoalRow(terminal);
    });
  }

  terminalizeGoal(
    goalId: string,
    status: ProjectGoalTerminalStatus,
    terminalReason?: ProjectGoalTerminalReason,
  ): ProjectGoalRecord {
    return this.transitionGoal(goalId, status, terminalReason);
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
