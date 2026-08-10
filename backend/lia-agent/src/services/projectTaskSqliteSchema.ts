import { chmodSync, closeSync, openSync, unlinkSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const PROJECT_TASK_SQLITE_SCHEMA_V1_VERSION = 1;
export const PROJECT_TASK_SQLITE_SCHEMA_V2_VERSION = 2;
export const PROJECT_TASK_SQLITE_SCHEMA_V3_VERSION = 3;
export const PROJECT_TASK_SQLITE_SCHEMA_VERSION = 4;

export const PROJECT_TASK_SQLITE_STAGES = [
  'accepted',
  'planning',
  'hermes',
  'codex',
  'verification',
  'commit',
  'completed',
  'failed',
] as const;

export const PROJECT_TASK_SQLITE_ERRORS = {
  invalidPath: 'invalid_project_task_sqlite_path',
  schema: 'invalid_project_task_sqlite_schema',
  corruptRecord: 'corrupt_project_task_record',
  closed: 'project_task_sqlite_closed',
  alreadyExists: 'project_task_sqlite_already_exists',
} as const;

const STAGE_LIST_SQL = PROJECT_TASK_SQLITE_STAGES.map((stage) => `'${stage}'`).join(', ');

export function createProjectTaskSqliteSchemaV1Sql(): string {
  return `
CREATE TABLE project_task_meta (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  schema_version INTEGER NOT NULL CHECK (schema_version >= 1)
) STRICT;

INSERT INTO project_task_meta (singleton, schema_version)
VALUES (1, ${PROJECT_TASK_SQLITE_SCHEMA_V1_VERSION});

CREATE TABLE project_tasks (
  task_id TEXT PRIMARY KEY CHECK (task_id <> ''),
  fingerprint TEXT NOT NULL CHECK (fingerprint <> ''),
  intent_json TEXT NOT NULL
    CHECK (json_valid(intent_json))
    CHECK (json_type(intent_json, '$') IS 'object'),
  status TEXT NOT NULL CHECK (status IN (${STAGE_LIST_SQL})),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  terminal_at INTEGER CHECK (terminal_at IS NULL OR terminal_at >= 0),
  receipt_json TEXT
    CHECK (receipt_json IS NULL OR (json_valid(receipt_json) AND json_type(receipt_json, '$') IS 'object')),
  error_json TEXT
    CHECK (error_json IS NULL OR (json_valid(error_json) AND json_type(error_json, '$') IS 'object')),
  CHECK ((status IN ('completed', 'failed')) = (terminal_at IS NOT NULL)),
  CHECK ((status = 'completed') = (receipt_json IS NOT NULL)),
  CHECK ((status = 'failed') = (error_json IS NOT NULL))
) STRICT;

CREATE INDEX project_tasks_terminal_at
ON project_tasks(terminal_at)
WHERE terminal_at IS NOT NULL;
`;
}


/** Transactionally upgrades supported legacy schemas without rewriting tasks. */
export function migrateProjectTaskSqliteDatabaseToCurrent(database: DatabaseSync): void {
  let meta: { singleton: unknown; schema_version: unknown } | undefined;
  try {
    meta = database.prepare(
      'SELECT singleton, schema_version FROM project_task_meta WHERE singleton = 1',
    ).get() as unknown as typeof meta;
  } catch {
    throw new Error(PROJECT_TASK_SQLITE_ERRORS.schema);
  }

  if (
    meta?.singleton !== 1
    || typeof meta.schema_version !== 'number'
    || !Number.isInteger(meta.schema_version)
  ) {
    throw new Error(PROJECT_TASK_SQLITE_ERRORS.schema);
  }

  if (
    meta.schema_version !== PROJECT_TASK_SQLITE_SCHEMA_V1_VERSION
    && meta.schema_version !== PROJECT_TASK_SQLITE_SCHEMA_V2_VERSION
    && meta.schema_version !== PROJECT_TASK_SQLITE_SCHEMA_V3_VERSION
    && meta.schema_version !== PROJECT_TASK_SQLITE_SCHEMA_VERSION
  ) {
    throw new Error(PROJECT_TASK_SQLITE_ERRORS.schema);
  }

  const migrate = (from: number, to: number, sql: string): void => {
    database.exec('BEGIN IMMEDIATE');
    try {
      database.exec(sql);
      const update = database.prepare(`
        UPDATE project_task_meta SET schema_version = ?
        WHERE singleton = 1 AND schema_version = ?
      `).run(to, from);
      if (Number(update.changes) !== 1) throw new Error(PROJECT_TASK_SQLITE_ERRORS.schema);
      database.exec('COMMIT');
    } catch {
      try { database.exec('ROLLBACK'); } catch {
        // Preserve the migration failure.
      }
      throw new Error(PROJECT_TASK_SQLITE_ERRORS.schema);
    }
  };

  if (meta.schema_version === PROJECT_TASK_SQLITE_SCHEMA_V1_VERSION) {
    migrate(PROJECT_TASK_SQLITE_SCHEMA_V1_VERSION, PROJECT_TASK_SQLITE_SCHEMA_V2_VERSION, `
      CREATE TABLE project_task_active_stage_traces (
        task_id TEXT PRIMARY KEY CHECK (task_id <> ''),
        completed_stages_json TEXT NOT NULL
          CHECK (json_valid(completed_stages_json) AND json_type(completed_stages_json, '$') IS 'array')
      ) STRICT
    `);
    meta.schema_version = PROJECT_TASK_SQLITE_SCHEMA_V2_VERSION;
  }

  if (meta.schema_version === PROJECT_TASK_SQLITE_SCHEMA_V2_VERSION) {
    migrate(PROJECT_TASK_SQLITE_SCHEMA_V2_VERSION, PROJECT_TASK_SQLITE_SCHEMA_V3_VERSION, `
      CREATE TABLE project_goals (
        goal_id TEXT PRIMARY KEY CHECK (goal_id <> ''),
        project_id TEXT NOT NULL CHECK (project_id <> ''),
        objective TEXT NOT NULL CHECK (length(objective) BETWEEN 1 AND 20000),
        status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'blocked', 'exhausted', 'failed')),
        created_at INTEGER NOT NULL CHECK (created_at >= 0),
        updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
        terminal_at INTEGER CHECK (terminal_at IS NULL OR terminal_at >= created_at),
        current_attempt INTEGER CHECK (current_attempt IS NULL OR current_attempt >= 0),
        max_attempts INTEGER NOT NULL CHECK (max_attempts BETWEEN 1 AND 5),
        continuation_depth_limit INTEGER NOT NULL CHECK (continuation_depth_limit BETWEEN 0 AND 4),
        terminal_reason TEXT CHECK (terminal_reason IS NULL OR terminal_reason IN (
          'objective_completed', 'human_intervention_required', 'attempt_limit_reached', 'unrecoverable_failure'
        )),
        CHECK ((status = 'active') = (terminal_at IS NULL)),
        CHECK (
          (status = 'active' AND terminal_reason IS NULL)
          OR (status = 'completed' AND terminal_reason = 'objective_completed')
          OR (status = 'blocked' AND terminal_reason = 'human_intervention_required')
          OR (status = 'exhausted' AND terminal_reason = 'attempt_limit_reached')
          OR (status = 'failed' AND terminal_reason = 'unrecoverable_failure')
        ),
        CHECK (current_attempt IS NULL OR current_attempt < max_attempts)
      ) STRICT;

      CREATE TABLE project_task_lineage (
        task_id TEXT PRIMARY KEY CHECK (task_id <> ''),
        goal_id TEXT NOT NULL CHECK (goal_id <> ''),
        parent_task_id TEXT CHECK (parent_task_id IS NULL OR parent_task_id <> task_id),
        continuation_depth INTEGER NOT NULL CHECK (continuation_depth >= 0),
        attempt_number INTEGER NOT NULL CHECK (attempt_number >= 0),
        UNIQUE (goal_id, task_id),
        UNIQUE (goal_id, attempt_number),
        UNIQUE (parent_task_id),
        FOREIGN KEY (task_id) REFERENCES project_tasks(task_id),
        FOREIGN KEY (goal_id) REFERENCES project_goals(goal_id),
        FOREIGN KEY (goal_id, parent_task_id) REFERENCES project_task_lineage(goal_id, task_id)
      ) STRICT;

      CREATE INDEX project_task_lineage_goal_id ON project_task_lineage(goal_id, attempt_number);
      CREATE INDEX project_task_lineage_parent_task_id ON project_task_lineage(parent_task_id)
        WHERE parent_task_id IS NOT NULL;

      CREATE TRIGGER project_task_lineage_validate_insert
      BEFORE INSERT ON project_task_lineage
      BEGIN
        SELECT CASE WHEN (SELECT status FROM project_goals WHERE goal_id = NEW.goal_id) <> 'active'
          THEN RAISE(ABORT, 'project_goal_terminal') END;
        SELECT CASE WHEN (SELECT json_extract(intent_json, '$.projectId') FROM project_tasks WHERE task_id = NEW.task_id)
          <> (SELECT project_id FROM project_goals WHERE goal_id = NEW.goal_id)
          THEN RAISE(ABORT, 'project_task_parent_project_mismatch') END;
        SELECT CASE WHEN NEW.parent_task_id IS NULL AND NOT (
          NEW.continuation_depth = 0 AND NEW.attempt_number = 0
          AND (SELECT current_attempt FROM project_goals WHERE goal_id = NEW.goal_id) IS NULL
        ) THEN RAISE(ABORT, 'invalid_project_task_lineage') END;
        SELECT CASE WHEN NEW.parent_task_id IS NOT NULL AND NOT (
          NEW.continuation_depth = (SELECT continuation_depth + 1 FROM project_task_lineage WHERE task_id = NEW.parent_task_id)
          AND NEW.attempt_number = (SELECT attempt_number + 1 FROM project_task_lineage WHERE task_id = NEW.parent_task_id)
          AND (SELECT attempt_number FROM project_task_lineage WHERE task_id = NEW.parent_task_id)
            = (SELECT current_attempt FROM project_goals WHERE goal_id = NEW.goal_id)
        ) THEN RAISE(ABORT, 'invalid_project_task_lineage') END;
        SELECT CASE WHEN NEW.attempt_number >= (SELECT max_attempts FROM project_goals WHERE goal_id = NEW.goal_id)
          THEN RAISE(ABORT, 'project_goal_attempt_limit_reached') END;
        SELECT CASE WHEN NEW.continuation_depth > (SELECT continuation_depth_limit FROM project_goals WHERE goal_id = NEW.goal_id)
          THEN RAISE(ABORT, 'project_goal_continuation_depth_limit_reached') END;
      END;

      CREATE TRIGGER project_task_lineage_advance_goal
      AFTER INSERT ON project_task_lineage
      BEGIN
        UPDATE project_goals SET current_attempt = NEW.attempt_number WHERE goal_id = NEW.goal_id;
      END;

      CREATE TRIGGER project_task_lineage_immutable_update
      BEFORE UPDATE ON project_task_lineage
      BEGIN
        SELECT RAISE(ABORT, 'project_task_lineage_immutable');
      END;

      CREATE TRIGGER project_task_lineage_immutable_delete
      BEFORE DELETE ON project_task_lineage
      BEGIN
        SELECT RAISE(ABORT, 'project_task_lineage_immutable');
      END;

      CREATE TRIGGER project_task_lineage_task_identity_immutable
      BEFORE UPDATE OF task_id, intent_json ON project_tasks
      WHEN EXISTS (SELECT 1 FROM project_task_lineage WHERE task_id = OLD.task_id)
      BEGIN
        SELECT RAISE(ABORT, 'project_task_lineage_immutable');
      END;

      CREATE TRIGGER project_goals_terminal_immutable
      BEFORE UPDATE OF status, terminal_at, terminal_reason ON project_goals
      WHEN OLD.status <> 'active'
      BEGIN
        SELECT RAISE(ABORT, 'invalid_project_goal_transition');
      END
    `);
    meta.schema_version = PROJECT_TASK_SQLITE_SCHEMA_V3_VERSION;
  }

  if (meta.schema_version === PROJECT_TASK_SQLITE_SCHEMA_V3_VERSION) {
    migrate(PROJECT_TASK_SQLITE_SCHEMA_V3_VERSION, PROJECT_TASK_SQLITE_SCHEMA_VERSION, `
      CREATE TABLE project_goal_evaluations (
        evaluation_id TEXT PRIMARY KEY CHECK (length(evaluation_id) = 36),
        goal_id TEXT NOT NULL CHECK (goal_id <> ''),
        task_id TEXT NOT NULL CHECK (task_id <> ''),
        attempt_number INTEGER NOT NULL CHECK (attempt_number >= 0),
        evaluator_version TEXT NOT NULL CHECK (evaluator_version = 'completion-evaluator-v1'),
        decision TEXT NOT NULL CHECK (decision IN ('completed', 'retryable', 'blocked', 'failed')),
        reason_code TEXT NOT NULL CHECK (reason_code IN (
          'goal_satisfied', 'partial_result', 'verification_failed', 'visual_verification_failed',
          'execution_failed', 'human_approval_required', 'forbidden_capability_required',
          'external_dependency', 'attempt_budget_exhausted', 'continuation_depth_exhausted',
          'insufficient_evidence'
        )),
        summary TEXT NOT NULL CHECK (length(summary) BETWEEN 1 AND 500),
        evidence_fingerprint TEXT NOT NULL CHECK (
          length(evidence_fingerprint) = 64 AND evidence_fingerprint NOT GLOB '*[^0-9a-f]*'
        ),
        created_at INTEGER NOT NULL CHECK (created_at >= 0),
        applied_at INTEGER CHECK (applied_at IS NULL OR applied_at >= created_at),
        UNIQUE (goal_id, task_id, evaluator_version, evidence_fingerprint),
        UNIQUE (goal_id, task_id, evaluator_version),
        FOREIGN KEY (goal_id) REFERENCES project_goals(goal_id),
        FOREIGN KEY (task_id) REFERENCES project_tasks(task_id),
        FOREIGN KEY (goal_id, task_id) REFERENCES project_task_lineage(goal_id, task_id),
        CHECK (
          (decision = 'completed' AND reason_code = 'goal_satisfied')
          OR (decision = 'blocked' AND reason_code IN (
            'human_approval_required', 'forbidden_capability_required', 'external_dependency'
          ))
          OR (decision = 'retryable' AND reason_code IN (
            'partial_result', 'verification_failed', 'visual_verification_failed',
            'execution_failed', 'insufficient_evidence'
          ))
          OR (decision = 'failed' AND reason_code IN (
            'execution_failed', 'attempt_budget_exhausted', 'continuation_depth_exhausted'
          ))
        )
      ) STRICT;

      CREATE INDEX project_goal_evaluations_goal_created
      ON project_goal_evaluations(goal_id, created_at DESC, evaluation_id DESC);

      CREATE TRIGGER project_goal_evaluations_validate_insert
      BEFORE INSERT ON project_goal_evaluations
      BEGIN
        SELECT CASE WHEN NEW.attempt_number <>
          (SELECT attempt_number FROM project_task_lineage
           WHERE task_id = NEW.task_id AND goal_id = NEW.goal_id)
          THEN RAISE(ABORT, 'project_goal_evaluation_attempt_mismatch') END;
      END;

      CREATE TRIGGER project_goal_evaluations_decision_immutable
      BEFORE UPDATE OF evaluation_id, goal_id, task_id, attempt_number, evaluator_version,
                       decision, reason_code, summary, evidence_fingerprint, created_at
      ON project_goal_evaluations
      BEGIN
        SELECT RAISE(ABORT, 'project_goal_evaluation_immutable');
      END;

      CREATE TRIGGER project_goal_evaluations_applied_once
      BEFORE UPDATE OF applied_at ON project_goal_evaluations
      WHEN OLD.applied_at IS NOT NULL OR NEW.applied_at IS NULL
      BEGIN
        SELECT RAISE(ABORT, 'project_goal_evaluation_immutable');
      END;

      CREATE TRIGGER project_goal_evaluations_validate_apply
      AFTER UPDATE OF applied_at ON project_goal_evaluations
      WHEN NEW.applied_at IS NOT NULL
      BEGIN
        SELECT CASE
          WHEN NEW.decision = 'retryable'
            AND (SELECT status FROM project_goals WHERE goal_id = NEW.goal_id) <> 'active'
            THEN RAISE(ABORT, 'project_goal_evaluation_incompatible_state')
          WHEN NEW.decision = 'completed'
            AND (SELECT status FROM project_goals WHERE goal_id = NEW.goal_id) <> 'completed'
            THEN RAISE(ABORT, 'project_goal_evaluation_incompatible_state')
          WHEN NEW.decision = 'blocked'
            AND (SELECT status FROM project_goals WHERE goal_id = NEW.goal_id) <> 'blocked'
            THEN RAISE(ABORT, 'project_goal_evaluation_incompatible_state')
          WHEN NEW.decision = 'failed' AND NEW.reason_code IN (
            'attempt_budget_exhausted', 'continuation_depth_exhausted'
          ) AND (SELECT status FROM project_goals WHERE goal_id = NEW.goal_id) <> 'exhausted'
            THEN RAISE(ABORT, 'project_goal_evaluation_incompatible_state')
          WHEN NEW.decision = 'failed' AND NEW.reason_code = 'execution_failed'
            AND (SELECT status FROM project_goals WHERE goal_id = NEW.goal_id) <> 'failed'
            THEN RAISE(ABORT, 'project_goal_evaluation_incompatible_state')
        END;
      END;

      CREATE TRIGGER project_goal_evaluations_immutable_delete
      BEFORE DELETE ON project_goal_evaluations
      BEGIN
        SELECT RAISE(ABORT, 'project_goal_evaluation_immutable');
      END;

      CREATE TRIGGER project_goal_attempt_terminal_evidence_immutable
      BEFORE UPDATE OF status, terminal_at, receipt_json, error_json ON project_tasks
      WHEN OLD.terminal_at IS NOT NULL
        AND EXISTS (SELECT 1 FROM project_task_lineage WHERE task_id = OLD.task_id)
      BEGIN
        SELECT RAISE(ABORT, 'project_goal_attempt_terminal_evidence_immutable');
      END;

      CREATE TRIGGER project_goal_evaluation_identity_immutable
      BEFORE UPDATE OF goal_id, project_id, objective, max_attempts, continuation_depth_limit
      ON project_goals
      WHEN EXISTS (SELECT 1 FROM project_task_lineage WHERE goal_id = OLD.goal_id)
      BEGIN
        SELECT RAISE(ABORT, 'project_goal_evaluation_incompatible_state');
      END
    `);
  }
}

function isErrorWithCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

/** Creates a private (0600) SQLite file with the versioned schema. */
export function initializeProjectTaskSqliteDatabaseV1(databasePath: string): void {
  if (!isAbsolute(databasePath) || databasePath.includes('\0')) {
    throw new Error(PROJECT_TASK_SQLITE_ERRORS.invalidPath);
  }

  let descriptor: number | undefined;
  let database: DatabaseSync | undefined;
  let created = false;

  try {
    try {
      descriptor = openSync(databasePath, 'wx', 0o600);
      created = true;
    } catch (error) {
      if (isErrorWithCode(error, 'EEXIST')) {
        throw new Error(PROJECT_TASK_SQLITE_ERRORS.alreadyExists);
      }

      throw error;
    }

    closeSync(descriptor);
    descriptor = undefined;

    // openSync applies the process umask, so enforce the private mode explicitly.
    chmodSync(databasePath, 0o600);

    database = new DatabaseSync(databasePath);
    database.exec(createProjectTaskSqliteSchemaV1Sql());
    database.close();
    database = undefined;
  } catch (error) {
    if (database?.isOpen) {
      try {
        database.close();
      } catch {
        // Preserve the original initialization error.
      }
    }

    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Preserve the original initialization error.
      }
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
