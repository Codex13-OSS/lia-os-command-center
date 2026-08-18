import type { AgendaRecurrenceR3 } from './agendaRecurrenceR3';
import { isValidAgendaTimezoneR3, validateAgendaRecurrenceR3 } from './agendaRecurrenceR3';

export type AgendaPriorityR3 = 'low' | 'medium' | 'high' | 'critical';
export type AgendaEventStatusR3 = 'draft' | 'scheduled' | 'confirmed' | 'completed' | 'cancelled' | 'postponed';
export type AgendaTemporalStateR3 = 'upcoming' | 'in_progress' | 'past';
export type AgendaEventModeR3 = 'in_person' | 'virtual' | 'hybrid';
export type AgendaAttendeeResponseR3 = 'pending' | 'accepted' | 'tentative' | 'declined';
export type AgendaEventSourceR3 = 'seed' | 'local' | 'migrated_v1' | 'external';

export interface AgendaDestinationR3 { name: string; address?: string; latitude?: number; longitude?: number; mapX?: number; mapY?: number }
export interface AgendaResponsibleR3 { id?: string; name: string; email?: string }
export interface AgendaAttendeeR3 { id?: string; name: string; email?: string; role?: string; response: AgendaAttendeeResponseR3 }
export interface AgendaEventR3 {
  id: string; title: string; startTime: string; endTime: string; timezone: string; mode: AgendaEventModeR3;
  locationName?: string; destination?: AgendaDestinationR3; priority: AgendaPriorityR3; status: AgendaEventStatusR3;
  attendees: AgendaAttendeeR3[]; responsible: AgendaResponsibleR3; objective?: string; notes?: string;
  preparationMinutes: number; parkingMinutes: number; walkingMinutes: number; followUpRequired: boolean;
  recurrence: AgendaRecurrenceR3; createdAt: string; updatedAt: string; source: AgendaEventSourceR3;
}
export interface AgendaValidationErrorR3 { path: string; message: string }
export type AgendaEventValidationResultR3 = { success: true; event: AgendaEventR3 } | { success: false; errors: AgendaValidationErrorR3[] };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const stringValue = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const iso = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v));
const oneOf = <T extends string>(v: unknown, values: readonly T[]): v is T => typeof v === 'string' && values.includes(v as T);

export function validateAgendaEventR3(value: unknown): AgendaEventValidationResultR3 {
  const errors: AgendaValidationErrorR3[] = [];
  if (!isRecord(value)) return { success: false, errors: [{ path: '$', message: 'Debe ser un objeto' }] };
  const requiredStrings = ['id', 'title'] as const;
  for (const key of requiredStrings) if (!stringValue(value[key])) errors.push({ path: key, message: 'Debe ser texto no vacío' });
  for (const key of ['startTime', 'endTime', 'createdAt', 'updatedAt'] as const) if (!iso(value[key])) errors.push({ path: key, message: 'Debe ser una fecha ISO válida' });
  if (iso(value.startTime) && iso(value.endTime) && Date.parse(value.startTime) >= Date.parse(value.endTime)) errors.push({ path: 'endTime', message: 'Debe ser posterior a startTime' });
  if (iso(value.createdAt) && iso(value.updatedAt) && Date.parse(value.updatedAt) < Date.parse(value.createdAt)) errors.push({ path: 'updatedAt', message: 'No puede ser anterior a createdAt' });
  if (!stringValue(value.timezone) || !isValidAgendaTimezoneR3(value.timezone)) errors.push({ path: 'timezone', message: 'Timezone inválida' });
  if (!oneOf(value.mode, ['in_person', 'virtual', 'hybrid'])) errors.push({ path: 'mode', message: 'Modalidad inválida' });
  if (!oneOf(value.priority, ['low', 'medium', 'high', 'critical'])) errors.push({ path: 'priority', message: 'Prioridad inválida' });
  if (!oneOf(value.status, ['draft', 'scheduled', 'confirmed', 'completed', 'cancelled', 'postponed'])) errors.push({ path: 'status', message: 'Estado inválido' });
  if (!oneOf(value.source, ['seed', 'local', 'migrated_v1', 'external'])) errors.push({ path: 'source', message: 'Fuente inválida' });
  for (const key of ['preparationMinutes', 'parkingMinutes', 'walkingMinutes'] as const) if (!Number.isInteger(value[key]) || (value[key] as number) < 0) errors.push({ path: key, message: 'Debe ser entero no negativo' });
  if (typeof value.followUpRequired !== 'boolean') errors.push({ path: 'followUpRequired', message: 'Debe ser booleano' });
  const validatePerson = (person: unknown, path: string, attendee: boolean): void => {
    if (!isRecord(person)) { errors.push({ path, message: 'Debe ser un objeto' }); return; }
    if (!stringValue(person.name)) errors.push({ path: `${path}.name`, message: 'Nombre obligatorio' });
    if (person.id !== undefined && typeof person.id !== 'string') errors.push({ path: `${path}.id`, message: 'ID inválido' });
    if (person.email !== undefined && typeof person.email !== 'string') errors.push({ path: `${path}.email`, message: 'Email inválido' });
    if (attendee && !oneOf(person.response, ['pending', 'accepted', 'tentative', 'declined'])) errors.push({ path: `${path}.response`, message: 'Respuesta inválida' });
  };
  validatePerson(value.responsible, 'responsible', false);
  if (!Array.isArray(value.attendees)) errors.push({ path: 'attendees', message: 'Debe ser una lista' }); else value.attendees.forEach((a, i) => validatePerson(a, `attendees[${i}]`, true));
  if (value.destination !== undefined) {
    if (!isRecord(value.destination)) errors.push({ path: 'destination', message: 'Debe ser un objeto' });
    else {
      if (!stringValue(value.destination.name)) errors.push({ path: 'destination.name', message: 'Nombre obligatorio' });
      const lat = value.destination.latitude, lon = value.destination.longitude;
      if (lat !== undefined && (typeof lat !== 'number' || !Number.isFinite(lat) || lat < -90 || lat > 90)) errors.push({ path: 'destination.latitude', message: 'Latitud fuera de rango' });
      if (lon !== undefined && (typeof lon !== 'number' || !Number.isFinite(lon) || lon < -180 || lon > 180)) errors.push({ path: 'destination.longitude', message: 'Longitud fuera de rango' });
      for (const key of ['address', 'mapX', 'mapY'] as const) if (value.destination[key] !== undefined && (key === 'address' ? typeof value.destination[key] !== 'string' : typeof value.destination[key] !== 'number' || !Number.isFinite(value.destination[key]))) errors.push({ path: `destination.${key}`, message: 'Valor inválido' });
    }
  }
  for (const key of ['locationName', 'objective', 'notes'] as const) if (value[key] !== undefined && typeof value[key] !== 'string') errors.push({ path: key, message: 'Debe ser texto' });
  const recurrence = validateAgendaRecurrenceR3(value.recurrence);
  if (!recurrence.success) recurrence.errors.forEach(e => errors.push({ path: `recurrence.${e.path}`, message: e.message }));
  if (errors.length) return { success: false, errors };
  const normalized = { ...value, attendees: (value.attendees as AgendaAttendeeR3[]).map(a => ({ ...a })), responsible: { ...(value.responsible as AgendaResponsibleR3) }, recurrence: recurrence.success ? recurrence.recurrence : { frequency: 'none' as const } } as AgendaEventR3;
  if (isRecord(value.destination)) normalized.destination = { ...value.destination } as unknown as AgendaDestinationR3;
  return { success: true, event: normalized };
}
