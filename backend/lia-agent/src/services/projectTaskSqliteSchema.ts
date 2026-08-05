import { chmodSync, closeSync, openSync, unlinkSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const PROJECT_TASK_SQLITE_SCHEMA_VERSION = 1;

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
VALUES (1, ${PROJECT_TASK_SQLITE_SCHEMA_VERSION});

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
