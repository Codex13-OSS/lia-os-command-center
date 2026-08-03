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
          SELECT payload_json
          FROM agenda_events
          ORDER BY start_time ASC, id ASC
        `).all() as Array<{ payload_json: unknown }>;

        const events = rows.map(({ payload_json }) => {
          if (typeof payload_json !== 'string') {
            throw new Error('invalid_agenda_payload_json');
          }

          return JSON.parse(payload_json) as AgendaEvent;
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
