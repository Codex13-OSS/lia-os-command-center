import { isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AgendaEvent } from '../contracts/agenda.js';
import type { AgendaReadSource } from './agendaReadSource.js';

const DEFAULT_TIMEZONE = 'America/Mexico_City';

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

        const rows = database.prepare(`
          SELECT id, start_time, payload_json
          FROM agenda_events
          ORDER BY start_time ASC, id ASC
        `).all() as Array<{
          id: unknown;
          start_time: unknown;
          payload_json: unknown;
        }>;

        const events = rows.map(({ id, start_time, payload_json }) => {
          if (typeof payload_json !== 'string') {
            throw new Error('invalid_agenda_payload_json');
          }

          const event = JSON.parse(payload_json) as unknown;

          if (typeof event !== 'object' || event === null || Array.isArray(event)) {
            throw new Error('invalid_agenda_payload_json');
          }

          const agendaEvent = event as AgendaEvent;

          if (agendaEvent.id !== id || agendaEvent.startTime !== start_time) {
            throw new Error('agenda_sqlite_metadata_mismatch');
          }

          return agendaEvent;
        });

        return {
          state: 'available' as const,
          timezone: DEFAULT_TIMEZONE,
          events,
        };
      } finally {
        database.close();
      }
    },
  };
}
