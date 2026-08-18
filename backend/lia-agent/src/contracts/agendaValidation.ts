import type {
  AgendaAttendee,
  AgendaDestination,
  AgendaEvent,
  AgendaEventMode,
  AgendaEventSource,
  AgendaEventStatus,
  AgendaPriority,
  AgendaReadState,
  AgendaRecurrence,
  AgendaResponsible,
} from './agenda.js';

export type AgendaValidationError = {
  path: string;
  message: string;
};

export type AgendaEventValidationResult =
  | { success: true; event: AgendaEvent }
  | { success: false; errors: AgendaValidationError[] };

export type AgendaReadPayload = {
  state: AgendaReadState;
  timezone: string;
  events: AgendaEvent[];
};

export type AgendaReadPayloadValidationResult =
  | { success: true; payload: AgendaReadPayload }
  | { success: false; errors: AgendaValidationError[] };

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const isIsoDate = (value: unknown): value is string =>
  typeof value === 'string' && Number.isFinite(Date.parse(value));

const isOneOf = <T extends string>(
  value: unknown,
  allowed: readonly T[],
): value is T =>
  typeof value === 'string' && allowed.includes(value as T);

export function isValidAgendaTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
}

function validateAgendaRecurrence(
  value: unknown,
): { success: true; recurrence: AgendaRecurrence } | { success: false; errors: AgendaValidationError[] } {
  const errors: AgendaValidationError[] = [];

  if (!isRecord(value)) {
    return {
      success: false,
      errors: [{ path: '$', message: 'Debe ser objeto' }],
    };
  }

  if (value.frequency === 'none') {
    return {
      success: true,
      recurrence: { frequency: 'none' },
    };
  }

  if (!isOneOf(value.frequency, ['daily', 'weekly', 'monthly'] as const)) {
    errors.push({ path: 'frequency', message: 'Frecuencia inválida' });
  }

  if (!Number.isInteger(value.interval) || (value.interval as number) <= 0) {
    errors.push({ path: 'interval', message: 'Debe ser entero positivo' });
  }

  if (
    value.count !== undefined
    && (!Number.isInteger(value.count) || (value.count as number) <= 0)
  ) {
    errors.push({ path: 'count', message: 'Debe ser entero positivo' });
  }

  if (value.until !== undefined && !isIsoDate(value.until)) {
    errors.push({ path: 'until', message: 'Debe ser ISO válido' });
  }

  let byWeekday: number[] | undefined;
  if (value.byWeekday !== undefined) {
    if (
      !Array.isArray(value.byWeekday)
      || value.byWeekday.some(
        (entry) => !Number.isInteger(entry) || entry < 0 || entry > 6,
      )
    ) {
      errors.push({
        path: 'byWeekday',
        message: 'Valores deben estar entre 0 y 6',
      });
    } else {
      byWeekday = [...new Set(value.byWeekday as number[])].sort((a, b) => a - b);
    }
  }

  let exceptions: string[] | undefined;
  if (value.exceptions !== undefined) {
    if (
      !Array.isArray(value.exceptions)
      || value.exceptions.some(
        (entry) => typeof entry !== 'string' || !DATE_KEY.test(entry),
      )
    ) {
      errors.push({
        path: 'exceptions',
        message: 'Fechas deben usar YYYY-MM-DD',
      });
    } else {
      exceptions = [...new Set(value.exceptions as string[])].sort();
    }
  }

  if (errors.length > 0) {
    return { success: false, errors };
  }

  return {
    success: true,
    recurrence: {
      frequency: value.frequency as 'daily' | 'weekly' | 'monthly',
      interval: value.interval as number,
      ...(value.count === undefined ? {} : { count: value.count as number }),
      ...(value.until === undefined ? {} : { until: value.until as string }),
      ...(byWeekday ? { byWeekday } : {}),
      ...(exceptions ? { exceptions } : {}),
    },
  };
}

export function validateAgendaEvent(value: unknown): AgendaEventValidationResult {
  const errors: AgendaValidationError[] = [];

  if (!isRecord(value)) {
    return {
      success: false,
      errors: [{ path: '$', message: 'Debe ser un objeto' }],
    };
  }

  for (const key of ['id', 'title'] as const) {
    if (!isNonEmptyString(value[key])) {
      errors.push({ path: key, message: 'Debe ser texto no vacío' });
    }
  }

  for (const key of ['startTime', 'endTime', 'createdAt', 'updatedAt'] as const) {
    if (!isIsoDate(value[key])) {
      errors.push({ path: key, message: 'Debe ser una fecha ISO válida' });
    }
  }

  if (
    isIsoDate(value.startTime)
    && isIsoDate(value.endTime)
    && Date.parse(value.startTime) >= Date.parse(value.endTime)
  ) {
    errors.push({ path: 'endTime', message: 'Debe ser posterior a startTime' });
  }

  if (
    isIsoDate(value.createdAt)
    && isIsoDate(value.updatedAt)
    && Date.parse(value.updatedAt) < Date.parse(value.createdAt)
  ) {
    errors.push({ path: 'updatedAt', message: 'No puede ser anterior a createdAt' });
  }

  if (!isNonEmptyString(value.timezone) || !isValidAgendaTimezone(value.timezone)) {
    errors.push({ path: 'timezone', message: 'Timezone inválida' });
  }

  if (!isOneOf(value.mode, ['in_person', 'virtual', 'hybrid'] as const)) {
    errors.push({ path: 'mode', message: 'Modalidad inválida' });
  }

  if (!isOneOf(value.priority, ['low', 'medium', 'high', 'critical'] as const)) {
    errors.push({ path: 'priority', message: 'Prioridad inválida' });
  }

  if (!isOneOf(
    value.status,
    ['draft', 'scheduled', 'confirmed', 'completed', 'cancelled', 'postponed'] as const,
  )) {
    errors.push({ path: 'status', message: 'Estado inválido' });
  }

  if (!isOneOf(value.source, ['local', 'migrated_v1', 'external'] as const)) {
    errors.push({ path: 'source', message: 'Fuente inválida' });
  }

  for (const key of ['preparationMinutes', 'parkingMinutes', 'walkingMinutes'] as const) {
    if (!Number.isInteger(value[key]) || (value[key] as number) < 0) {
      errors.push({ path: key, message: 'Debe ser entero no negativo' });
    }
  }

  if (typeof value.followUpRequired !== 'boolean') {
    errors.push({ path: 'followUpRequired', message: 'Debe ser booleano' });
  }

  const validatePerson = (
    person: unknown,
    path: string,
    attendee: boolean,
  ): void => {
    if (!isRecord(person)) {
      errors.push({ path, message: 'Debe ser un objeto' });
      return;
    }

    if (!isNonEmptyString(person.name)) {
      errors.push({ path: `${path}.name`, message: 'Nombre obligatorio' });
    }

    if (person.id !== undefined && typeof person.id !== 'string') {
      errors.push({ path: `${path}.id`, message: 'ID inválido' });
    }

    if (person.email !== undefined && typeof person.email !== 'string') {
      errors.push({ path: `${path}.email`, message: 'Email inválido' });
    }

    if (
      attendee
      && !isOneOf(
        person.response,
        ['pending', 'accepted', 'tentative', 'declined'] as const,
      )
    ) {
      errors.push({ path: `${path}.response`, message: 'Respuesta inválida' });
    }
  };

  validatePerson(value.responsible, 'responsible', false);

  if (!Array.isArray(value.attendees)) {
    errors.push({ path: 'attendees', message: 'Debe ser una lista' });
  } else {
    value.attendees.forEach((attendee, index) => {
      validatePerson(attendee, `attendees[${index}]`, true);
    });
  }

  if (value.destination !== undefined) {
    if (!isRecord(value.destination)) {
      errors.push({ path: 'destination', message: 'Debe ser un objeto' });
    } else {
      if (!isNonEmptyString(value.destination.name)) {
        errors.push({ path: 'destination.name', message: 'Nombre obligatorio' });
      }

      const latitude = value.destination.latitude;
      const longitude = value.destination.longitude;

      if (
        latitude !== undefined
        && (
          typeof latitude !== 'number'
          || !Number.isFinite(latitude)
          || latitude < -90
          || latitude > 90
        )
      ) {
        errors.push({ path: 'destination.latitude', message: 'Latitud fuera de rango' });
      }

      if (
        longitude !== undefined
        && (
          typeof longitude !== 'number'
          || !Number.isFinite(longitude)
          || longitude < -180
          || longitude > 180
        )
      ) {
        errors.push({ path: 'destination.longitude', message: 'Longitud fuera de rango' });
      }

      if (
        value.destination.address !== undefined
        && typeof value.destination.address !== 'string'
      ) {
        errors.push({ path: 'destination.address', message: 'Valor inválido' });
      }

      for (const key of ['mapX', 'mapY'] as const) {
        if (
          value.destination[key] !== undefined
          && (
            typeof value.destination[key] !== 'number'
            || !Number.isFinite(value.destination[key])
          )
        ) {
          errors.push({ path: `destination.${key}`, message: 'Valor inválido' });
        }
      }
    }
  }

  for (const key of ['locationName', 'objective', 'notes'] as const) {
    if (value[key] !== undefined && typeof value[key] !== 'string') {
      errors.push({ path: key, message: 'Debe ser texto' });
    }
  }

  const recurrence = validateAgendaRecurrence(value.recurrence);

  if (!recurrence.success) {
    recurrence.errors.forEach((error) => {
      errors.push({
        path: `recurrence.${error.path}`,
        message: error.message,
      });
    });
  }

  if (errors.length > 0) {
    return { success: false, errors };
  }

  const event: AgendaEvent = {
    ...(value as unknown as AgendaEvent),
    mode: value.mode as AgendaEventMode,
    priority: value.priority as AgendaPriority,
    status: value.status as AgendaEventStatus,
    source: value.source as AgendaEventSource,
    attendees: (value.attendees as AgendaAttendee[]).map((attendee) => ({
      ...attendee,
    })),
    responsible: {
      ...(value.responsible as AgendaResponsible),
    },
    ...(isRecord(value.destination)
      ? {
          destination: {
            ...(value.destination as AgendaDestination),
          },
        }
      : {}),
    recurrence: recurrence.success
      ? recurrence.recurrence
      : { frequency: 'none' },
  };

  return { success: true, event };
}

export function validateAgendaReadPayload(
  value: unknown,
): AgendaReadPayloadValidationResult {
  const errors: AgendaValidationError[] = [];

  if (!isRecord(value)) {
    return {
      success: false,
      errors: [{ path: '$', message: 'Debe ser un objeto' }],
    };
  }

  if (!isOneOf(value.state, ['unconfigured', 'available', 'unavailable'] as const)) {
    errors.push({ path: 'state', message: 'Estado de lectura inválido' });
  }

  if (!isNonEmptyString(value.timezone) || !isValidAgendaTimezone(value.timezone)) {
    errors.push({ path: 'timezone', message: 'Timezone inválida' });
  }

  const events: AgendaEvent[] = [];
  const ids = new Set<string>();

  if (!Array.isArray(value.events)) {
    errors.push({ path: 'events', message: 'Debe ser una lista' });
  } else {
    value.events.forEach((item, index) => {
      const result = validateAgendaEvent(item);

      if (!result.success) {
        result.errors.forEach((error) => {
          errors.push({
            path: `events[${index}].${error.path}`,
            message: error.message,
          });
        });
        return;
      }

      if (ids.has(result.event.id)) {
        errors.push({
          path: `events[${index}].id`,
          message: 'ID duplicado',
        });
        return;
      }

      ids.add(result.event.id);
      events.push(result.event);
    });
  }

  if (
    (value.state === 'unconfigured' || value.state === 'unavailable')
    && events.length > 0
  ) {
    errors.push({
      path: 'events',
      message: 'Estados no disponibles no pueden exponer eventos',
    });
  }

  if (errors.length > 0) {
    return { success: false, errors };
  }

  return {
    success: true,
    payload: {
      state: value.state as AgendaReadState,
      timezone: value.timezone as string,
      events,
    },
  };
}
