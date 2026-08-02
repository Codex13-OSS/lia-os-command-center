import {
  createAgendaContextSnapshot,
  type AgendaContextSnapshot,
} from '../contracts/agenda.js';
import { validateAgendaReadPayload } from '../contracts/agendaValidation.js';
import {
  createUnconfiguredAgendaReadSource,
  type AgendaReadSource,
} from './agendaReadSource.js';

export async function readSafeAgendaContext(
  source: AgendaReadSource = createUnconfiguredAgendaReadSource(),
): Promise<AgendaContextSnapshot> {
  try {
    const result = await source.read();
    const validation = validateAgendaReadPayload(result);

    if (!validation.success) {
      return createAgendaContextSnapshot(
        'unavailable',
        [],
        'America/Mexico_City',
      );
    }

    return createAgendaContextSnapshot(
      validation.payload.state,
      validation.payload.events,
      validation.payload.timezone,
    );
  } catch {
    return createAgendaContextSnapshot(
      'unavailable',
      [],
      'America/Mexico_City',
    );
  }
}
