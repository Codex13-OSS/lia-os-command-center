import { isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AgendaEvent } from '../contracts/agenda.js';
import type { AgendaReadSource } from './agendaReadSource.js';
import { AGENDA_SQLITE_SCHEMA_VERSION } from './agendaSqliteSchema.js';

export function createAgendaSqliteReadSource(
  databasePath: string,
): AgendaReadSource {
  if (!isAbsolute(databasePath)) {
    throw new Error('invalid_agenda_sqlite_path');
  }

  return {
    async read() {
      const database = new DatabaseSync(databasePath, { readOnly: true });

      try {
        database.exec('PRAGMA query_only=ON');

        let stateRows: Array<{
          singleton: unknown;
          schema_version: unknown;
          global_revision: unknown;
          timezone: unknown;
          updated_at: unknown;
        }>;

        try {
          stateRows = database.prepare(`
            SELECT singleton, schema_version, global_revision, timezone, updated_at
            FROM agenda_state
          `).all() as typeof stateRows;
        } catch {
          throw new Error('invalid_agenda_sqlite_state');
        }

        if (stateRows.length !== 1) {
          throw new Error('invalid_agenda_sqlite_state');
        }

        const [agendaState] = stateRows;

        if (
          agendaState === undefined ||
          agendaState.singleton !== 1 ||
          agendaState.schema_version !== AGENDA_SQLITE_SCHEMA_VERSION ||
          typeof agendaState.global_revision !== 'number' ||
          !Number.isInteger(agendaState.global_revision) ||
          agendaState.global_revision < 0 ||
          typeof agendaState.timezone !== 'string' ||
          agendaState.timezone.trim() === '' ||
          typeof agendaState.updated_at !== 'string' ||
          agendaState.updated_at.trim() === ''
        ) {
          throw new Error('invalid_agenda_sqlite_state');
        }

        const rows = database.prepare(`
          SELECT id, start_time, payload_json
          FROM agenda_events
          ORDER BY start_time ASC, id ASC
        `).all() as Array<{
          id: unknown;
          start_time: unknown;
          payload_json: unknown;
        }>;

        const events = rows.flatMap(({ id, start_time, payload_json }) => {
          if (typeof payload_json !== 'string') {
            throw new Error('invalid_agenda_payload_json');
          }

          const event = JSON.parse(payload_json) as unknown;

          if (typeof event !== 'object' || event === null || Array.isArray(event)) {
            throw new Error('invalid_agenda_payload_json');
          }

          if ('source' in event && event.source === 'seed') {
            return [];
          }

          const agendaEvent = event as AgendaEvent;

          if (agendaEvent.id !== id || agendaEvent.startTime !== start_time) {
            throw new Error('agenda_sqlite_metadata_mismatch');
          }

          return [agendaEvent];
        });

        return {
          state: 'available' as const,
          timezone: agendaState.timezone,
          events,
        };
      } finally {
        database.close();
      }
    },
  };
}
