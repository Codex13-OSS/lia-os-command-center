import { chmodSync, closeSync, openSync, unlinkSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const PROJECT_TASK_SQLITE_SCHEMA_V1_VERSION = 1;
export const PROJECT_TASK_SQLITE_SCHEMA_V2_VERSION = 2;
export const PROJECT_TASK_SQLITE_SCHEMA_V3_VERSION = 3;
export const PROJECT_TASK_SQLITE_SCHEMA_V4_VERSION = 4;
export const PROJECT_TASK_SQLITE_SCHEMA_V5_VERSION = 5;
export const PROJECT_TASK_SQLITE_SCHEMA_V6_VERSION = 6;
export const PROJECT_TASK_SQLITE_SCHEMA_VERSION = 7;

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
    && meta.schema_version !== PROJECT_TASK_SQLITE_SCHEMA_V4_VERSION
    && meta.schema_version !== PROJECT_TASK_SQLITE_SCHEMA_V5_VERSION
    && meta.schema_version !== PROJECT_TASK_SQLITE_SCHEMA_V6_VERSION
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
    migrate(PROJECT_TASK_SQLITE_SCHEMA_V3_VERSION, PROJECT_TASK_SQLITE_SCHEMA_V4_VERSION, `
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
    meta.schema_version = PROJECT_TASK_SQLITE_SCHEMA_V4_VERSION;
  }

  if (meta.schema_version === PROJECT_TASK_SQLITE_SCHEMA_V4_VERSION) {
    migrate(PROJECT_TASK_SQLITE_SCHEMA_V4_VERSION, PROJECT_TASK_SQLITE_SCHEMA_V5_VERSION, `
      CREATE TABLE project_goal_continuation_plans (
        plan_id TEXT PRIMARY KEY CHECK (length(plan_id) = 36),
        goal_id TEXT NOT NULL CHECK (goal_id <> ''),
        source_evaluation_id TEXT NOT NULL CHECK (source_evaluation_id <> ''),
        parent_task_id TEXT NOT NULL CHECK (parent_task_id <> ''),
        parent_attempt_number INTEGER NOT NULL CHECK (parent_attempt_number >= 0),
        next_attempt_number INTEGER NOT NULL CHECK (next_attempt_number = parent_attempt_number + 1),
        next_continuation_depth INTEGER NOT NULL CHECK (next_continuation_depth > 0),
        planner_version TEXT NOT NULL CHECK (planner_version = 'continuation-planner-v1'),
        status TEXT NOT NULL CHECK (status IN ('planned', 'cancelled')),
        instruction TEXT NOT NULL CHECK (
          length(instruction) BETWEEN 1 AND 2000 AND instruction = trim(instruction)
          AND lower(instruction) NOT LIKE '%deploy%'
          AND lower(instruction) NOT LIKE '%push%'
          AND lower(instruction) NOT LIKE '%merge%'
          AND lower(instruction) NOT LIKE '%production%'
          AND lower(instruction) NOT LIKE '%secret%'
          AND lower(instruction) NOT LIKE '%credential%'
          AND lower(instruction) NOT LIKE '%shell%'
          AND lower(instruction) NOT LIKE '%sudo%'
          AND lower(instruction) NOT LIKE '%requestedcapabilities%'
          AND lower(instruction) NOT LIKE '%approvedcapabilities%'
          AND lower(instruction) NOT LIKE '%effectivecapabilities%'
          AND lower(instruction) NOT LIKE '%repository_read%'
          AND lower(instruction) NOT LIKE '%isolated_worktree_write%'
          AND lower(instruction) NOT LIKE '%run_tests%'
          AND lower(instruction) NOT LIKE '%local_commit%'
        ),
        reason_code TEXT NOT NULL CHECK (reason_code IN (
          'continue_partial_result', 'retry_verification_failure', 'retry_visual_failure',
          'retry_execution_failure', 'retry_insufficient_evidence'
        )),
        fingerprint TEXT NOT NULL CHECK (
          length(fingerprint) = 64 AND fingerprint NOT GLOB '*[^0-9a-f]*'
        ),
        source_evidence_fingerprint TEXT NOT NULL CHECK (
          length(source_evidence_fingerprint) = 64
          AND source_evidence_fingerprint NOT GLOB '*[^0-9a-f]*'
        ),
        created_at INTEGER NOT NULL CHECK (created_at >= 0),
        cancelled_at INTEGER CHECK (cancelled_at IS NULL OR cancelled_at >= created_at),
        UNIQUE (source_evaluation_id, planner_version),
        FOREIGN KEY (goal_id) REFERENCES project_goals(goal_id),
        FOREIGN KEY (source_evaluation_id) REFERENCES project_goal_evaluations(evaluation_id),
        FOREIGN KEY (parent_task_id) REFERENCES project_tasks(task_id),
        CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL))
      ) STRICT;

      CREATE INDEX project_goal_continuation_plans_goal_created
      ON project_goal_continuation_plans(goal_id, created_at ASC, plan_id ASC);

      CREATE INDEX project_goal_continuation_plans_parent
      ON project_goal_continuation_plans(parent_task_id, parent_attempt_number);

      CREATE TRIGGER project_goal_continuation_plans_validate_insert
      BEFORE INSERT ON project_goal_continuation_plans
      BEGIN
        SELECT CASE WHEN NEW.status <> 'planned' OR NEW.cancelled_at IS NOT NULL
          THEN RAISE(ABORT, 'invalid_project_goal_continuation_plan') END;
        SELECT CASE WHEN (SELECT goal_id FROM project_goal_evaluations
          WHERE evaluation_id = NEW.source_evaluation_id) IS NOT NEW.goal_id
          THEN RAISE(ABORT, 'project_goal_continuation_plan_goal_mismatch') END;
        SELECT CASE WHEN (SELECT applied_at FROM project_goal_evaluations
          WHERE evaluation_id = NEW.source_evaluation_id) IS NULL
          THEN RAISE(ABORT, 'project_goal_continuation_plan_evaluation_not_applied') END;
        SELECT CASE WHEN (SELECT decision FROM project_goal_evaluations
          WHERE evaluation_id = NEW.source_evaluation_id) IS NOT 'retryable'
          THEN RAISE(ABORT, 'project_goal_continuation_plan_evaluation_not_retryable') END;
        SELECT CASE WHEN NOT EXISTS (
          SELECT 1 FROM project_goal_evaluations
          WHERE evaluation_id = NEW.source_evaluation_id
            AND (
              (reason_code = 'partial_result' AND NEW.reason_code = 'continue_partial_result')
              OR (reason_code = 'verification_failed' AND NEW.reason_code = 'retry_verification_failure')
              OR (reason_code = 'visual_verification_failed' AND NEW.reason_code = 'retry_visual_failure')
              OR (reason_code = 'execution_failed' AND NEW.reason_code = 'retry_execution_failure')
              OR (reason_code = 'insufficient_evidence' AND NEW.reason_code = 'retry_insufficient_evidence')
            )
        ) THEN RAISE(ABORT, 'project_goal_continuation_plan_incompatible') END;
        SELECT CASE WHEN (SELECT evidence_fingerprint FROM project_goal_evaluations
          WHERE evaluation_id = NEW.source_evaluation_id) IS NOT NEW.source_evidence_fingerprint
          THEN RAISE(ABORT, 'project_goal_continuation_plan_evidence_conflict') END;
        SELECT CASE WHEN (SELECT task_id FROM project_goal_evaluations
          WHERE evaluation_id = NEW.source_evaluation_id) IS NOT NEW.parent_task_id
          THEN RAISE(ABORT, 'project_goal_continuation_plan_incompatible') END;
        SELECT CASE WHEN NOT EXISTS (
          SELECT 1 FROM project_task_lineage AS lineage
          JOIN project_goals AS goal ON goal.goal_id = lineage.goal_id
          JOIN project_tasks AS task ON task.task_id = lineage.task_id
          WHERE lineage.task_id = NEW.parent_task_id
            AND lineage.goal_id = NEW.goal_id
            AND lineage.attempt_number = NEW.parent_attempt_number
            AND NEW.next_attempt_number = lineage.attempt_number + 1
            AND NEW.next_continuation_depth = lineage.continuation_depth + 1
            AND goal.status = 'active'
            AND goal.current_attempt = lineage.attempt_number
            AND NEW.next_attempt_number < goal.max_attempts
            AND NEW.next_continuation_depth <= goal.continuation_depth_limit
            AND json_extract(task.intent_json, '$.projectId') = goal.project_id
        ) THEN RAISE(ABORT, 'project_goal_continuation_plan_incompatible') END;
      END;

      CREATE TRIGGER project_goal_continuation_plans_identity_immutable
      BEFORE UPDATE OF plan_id, goal_id, source_evaluation_id, parent_task_id,
                       parent_attempt_number, next_attempt_number, next_continuation_depth,
                       planner_version, instruction, reason_code, fingerprint,
                       source_evidence_fingerprint, created_at
      ON project_goal_continuation_plans
      BEGIN
        SELECT RAISE(ABORT, 'project_goal_continuation_plan_immutable');
      END;

      CREATE TRIGGER project_goal_continuation_plans_cancel_once
      BEFORE UPDATE OF status, cancelled_at ON project_goal_continuation_plans
      WHEN NOT (
        OLD.status = 'planned' AND OLD.cancelled_at IS NULL
        AND NEW.status = 'cancelled' AND NEW.cancelled_at IS NOT NULL
        AND NEW.cancelled_at >= OLD.created_at
      )
      BEGIN
        SELECT RAISE(ABORT, 'project_goal_continuation_plan_immutable');
      END;

      CREATE TRIGGER project_goal_continuation_plans_immutable_delete
      BEFORE DELETE ON project_goal_continuation_plans
      BEGIN
        SELECT RAISE(ABORT, 'project_goal_continuation_plan_immutable');
      END
    `);
    meta.schema_version = PROJECT_TASK_SQLITE_SCHEMA_V5_VERSION;
  }

  if (meta.schema_version === PROJECT_TASK_SQLITE_SCHEMA_V5_VERSION) {
    migrate(PROJECT_TASK_SQLITE_SCHEMA_V5_VERSION, PROJECT_TASK_SQLITE_SCHEMA_V6_VERSION, `
      CREATE TABLE project_goal_continuation_consumptions (
        plan_id TEXT PRIMARY KEY CHECK (length(plan_id) = 36),
        created_task_id TEXT NOT NULL UNIQUE CHECK (length(created_task_id) = 36),
        consumed_at INTEGER NOT NULL CHECK (consumed_at >= 0),
        FOREIGN KEY (plan_id) REFERENCES project_goal_continuation_plans(plan_id),
        FOREIGN KEY (created_task_id) REFERENCES project_tasks(task_id)
      ) STRICT;

      CREATE TRIGGER project_goal_continuation_consumptions_validate_insert
      BEFORE INSERT ON project_goal_continuation_consumptions
      BEGIN
        SELECT CASE WHEN NOT EXISTS (
          SELECT 1
          FROM project_goal_continuation_plans AS plan
          JOIN project_goal_evaluations AS evaluation
            ON evaluation.evaluation_id = plan.source_evaluation_id
          JOIN project_goals AS goal ON goal.goal_id = plan.goal_id
          JOIN project_task_lineage AS parent_lineage
            ON parent_lineage.task_id = plan.parent_task_id AND parent_lineage.goal_id = plan.goal_id
          JOIN project_task_lineage AS child_lineage
            ON child_lineage.task_id = NEW.created_task_id AND child_lineage.goal_id = plan.goal_id
          JOIN project_tasks AS child ON child.task_id = NEW.created_task_id
          WHERE plan.plan_id = NEW.plan_id
            AND plan.status = 'planned' AND plan.cancelled_at IS NULL
            AND NEW.consumed_at >= plan.created_at
            AND evaluation.goal_id = plan.goal_id
            AND evaluation.task_id = plan.parent_task_id
            AND evaluation.attempt_number = plan.parent_attempt_number
            AND evaluation.evidence_fingerprint = plan.source_evidence_fingerprint
            AND evaluation.applied_at IS NOT NULL AND evaluation.decision = 'retryable'
            AND goal.status = 'active'
            AND goal.current_attempt = plan.next_attempt_number
            AND child_lineage.parent_task_id = plan.parent_task_id
            AND child_lineage.attempt_number = plan.next_attempt_number
            AND child_lineage.continuation_depth = plan.next_continuation_depth
            AND json_extract(child.intent_json, '$.projectId') = goal.project_id
            AND json_extract(child.intent_json, '$.instruction') = plan.instruction
            AND json_extract(child.intent_json, '$.priority') = (
              SELECT json_extract(intent_json, '$.priority')
              FROM project_tasks WHERE task_id = plan.parent_task_id
            )
            AND json_extract(child.intent_json, '$.requestedCapabilities') = (
              SELECT json_extract(intent_json, '$.requestedCapabilities')
              FROM project_tasks WHERE task_id = plan.parent_task_id
            )
        ) THEN RAISE(ABORT, 'project_continuation_plan_incompatible') END;
      END;

      CREATE TRIGGER project_goal_continuation_consumptions_immutable_update
      BEFORE UPDATE ON project_goal_continuation_consumptions
      BEGIN
        SELECT RAISE(ABORT, 'project_continuation_consumption_immutable');
      END;

      CREATE TRIGGER project_goal_continuation_consumptions_immutable_delete
      BEFORE DELETE ON project_goal_continuation_consumptions
      BEGIN
        SELECT RAISE(ABORT, 'project_continuation_consumption_immutable');
      END;

      CREATE TRIGGER project_goal_continuation_consumed_plan_state_immutable
      BEFORE UPDATE OF status, cancelled_at ON project_goal_continuation_plans
      WHEN EXISTS (
        SELECT 1 FROM project_goal_continuation_consumptions WHERE plan_id = OLD.plan_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'project_continuation_consumption_immutable');
      END
    `);
    meta.schema_version = PROJECT_TASK_SQLITE_SCHEMA_V6_VERSION;
  }

  if (meta.schema_version === PROJECT_TASK_SQLITE_SCHEMA_V6_VERSION) {
    migrate(PROJECT_TASK_SQLITE_SCHEMA_V6_VERSION, PROJECT_TASK_SQLITE_SCHEMA_VERSION, `
      CREATE TABLE project_task_lease_generations (
        task_id TEXT NOT NULL CHECK (task_id <> ''),
        lease_id TEXT NOT NULL UNIQUE CHECK (length(lease_id) = 36),
        lease_owner TEXT NOT NULL CHECK (
          length(lease_owner) BETWEEN 1 AND 200 AND lease_owner = trim(lease_owner)
        ),
        fencing_token INTEGER NOT NULL CHECK (
          fencing_token BETWEEN 1 AND 9007199254740991
        ),
        acquired_at INTEGER NOT NULL CHECK (
          acquired_at BETWEEN 0 AND 9007199254740991
        ),
        lease_expires_at INTEGER NOT NULL CHECK (
          lease_expires_at > acquired_at AND lease_expires_at <= 9007199254740991
        ),
        released_at INTEGER CHECK (
          released_at IS NULL OR released_at BETWEEN acquired_at AND 9007199254740991
        ),
        PRIMARY KEY (task_id, fencing_token)
      ) STRICT;

      CREATE UNIQUE INDEX project_task_lease_one_current_generation
      ON project_task_lease_generations(task_id)
      WHERE released_at IS NULL;

      CREATE TRIGGER project_task_lease_validate_insert
      BEFORE INSERT ON project_task_lease_generations
      BEGIN
        SELECT CASE WHEN NOT EXISTS (
          SELECT 1 FROM project_tasks
          WHERE task_id = NEW.task_id AND status NOT IN ('completed', 'failed')
        ) THEN RAISE(ABORT, 'project_task_lease_task_unavailable') END;
        SELECT CASE WHEN NEW.fencing_token <> COALESCE((
          SELECT MAX(fencing_token) + 1
          FROM project_task_lease_generations WHERE task_id = NEW.task_id
        ), 1) THEN RAISE(ABORT, 'project_task_lease_invalid_fencing_token') END;
      END;

      CREATE TRIGGER project_task_lease_identity_immutable
      BEFORE UPDATE OF task_id, lease_id, lease_owner, fencing_token, acquired_at
      ON project_task_lease_generations
      BEGIN
        SELECT RAISE(ABORT, 'project_task_lease_generation_immutable');
      END;

      CREATE TRIGGER project_task_lease_expiry_monotonic
      BEFORE UPDATE OF lease_expires_at ON project_task_lease_generations
      WHEN NEW.lease_expires_at <= OLD.lease_expires_at
        OR OLD.released_at IS NOT NULL
      BEGIN
        SELECT RAISE(ABORT, 'project_task_lease_invalid_renewal');
      END;

      CREATE TRIGGER project_task_lease_release_once
      BEFORE UPDATE OF released_at ON project_task_lease_generations
      WHEN OLD.released_at IS NOT NULL OR NEW.released_at IS NULL
      BEGIN
        SELECT RAISE(ABORT, 'project_task_lease_generation_immutable');
      END;

      CREATE TRIGGER project_task_lease_generation_immutable_delete
      BEFORE DELETE ON project_task_lease_generations
      BEGIN
        SELECT RAISE(ABORT, 'project_task_lease_generation_immutable');
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
