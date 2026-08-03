import { closeSync, openSync, unlinkSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createAgendaSqliteSchemaV1Sql } from './agendaSqliteSchema.js';

export function initializeAgendaSqliteDatabaseV1(
  databasePath: string,
  initializedAt: string,
): void {
  if (!isAbsolute(databasePath) || databasePath.includes('\0')) {
    throw new Error('invalid_agenda_sqlite_path');
  }

  const schemaSql = createAgendaSqliteSchemaV1Sql(initializedAt);
  let descriptor: number | undefined;
  let database: DatabaseSync | undefined;
  let created = false;

  try {
    try {
      descriptor = openSync(databasePath, 'wx', 0o600);
      created = true;
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'EEXIST'
      ) {
        throw new Error('agenda_sqlite_already_exists');
      }

      throw error;
    }

    closeSync(descriptor);
    descriptor = undefined;

    database = new DatabaseSync(databasePath);
    database.exec(schemaSql);
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
