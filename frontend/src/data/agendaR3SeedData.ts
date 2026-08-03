import type { AgendaEventR3 } from '../domain/agendaEventR3';
import {
  addAgendaLocalDaysR3,
  getAgendaLocalDateKeyR3,
  getZonedDatePartsR3,
  zonedDateTimeToIsoR3,
} from '../domain/agendaRecurrenceR3';

const slug = (iso: string) => iso.replace(/[-:.TZ]/g, '').slice(0, 14);

const localTimeToEpoch = (
  dateKey: string,
  minuteOfDay: number,
  timezone: string,
): number => {
  const [year, month, day] = dateKey.split('-').map(Number);
  const hour = Math.floor(minuteOfDay / 60);
  const minute = minuteOfDay % 60;

  return Date.parse(zonedDateTimeToIsoR3({
    year,
    month,
    day,
    hour,
    minute,
    second: 0,
  }, timezone));
};

export function createAgendaSeedEventsR3(
  anchor: Date,
  timezone = 'America/Mexico_City',
): AgendaEventR3[] {
  if (!Number.isFinite(anchor.getTime())) throw new RangeError('Anchor inválido');

  const createdAt = anchor.toISOString();
  const make = (
    id: string,
    title: string,
    start: number,
    duration: number,
    extra: Partial<AgendaEventR3>,
  ): AgendaEventR3 => ({
    id: `seed-${slug(createdAt)}-${id}`,
    title,
    startTime: new Date(start).toISOString(),
    endTime: new Date(start + duration * 60000).toISOString(),
    timezone,
    mode: 'virtual',
    priority: 'medium',
    status: 'confirmed',
    attendees: [],
    responsible: { name: 'Dirección' },
    preparationMinutes: 15,
    parkingMinutes: 0,
    walkingMinutes: 0,
    followUpRequired: false,
    recurrence: { frequency: 'none' },
    createdAt,
    updatedAt: createdAt,
    source: 'seed',
    ...extra,
  });

  const anchorKey = getAgendaLocalDateKeyR3(anchor, timezone);
  const local = getZonedDatePartsR3(anchor, timezone);
  const currentMinute = local.hour * 60 + local.minute;

  /*
   * Mantiene los seeds dentro de la jornada 07:00–20:00.
   * Hasta las 15:45 se usa el día actual; después se usa el día siguiente.
   * La primera cita nunca inicia antes de 09:30 ni después de 17:15.
   */
  const canUseToday = currentMinute <= 15 * 60 + 45;
  const firstDayKey = canUseToday
    ? anchorKey
    : addAgendaLocalDaysR3(anchorKey, 1);

  const firstMinute = canUseToday
    ? Math.min(Math.max(currentMinute + 90, 9 * 60 + 30), 17 * 60 + 15)
    : 9 * 60 + 30;

  const first = localTimeToEpoch(firstDayKey, firstMinute, timezone);
  const second = first + 120 * 60000;

  const physicalDayKey = addAgendaLocalDaysR3(firstDayKey, 1);
  const physical = localTimeToEpoch(physicalDayKey, 10 * 60 + 30, timezone);
  const follow = physical + 150 * 60000;

  return [
    make('risk', 'Revisión de riesgos', first, 60, {
      mode: 'in_person',
      locationName: 'Centro de Convenciones',
      destination: { name: 'Centro de Convenciones' },
      priority: 'high',
      responsible: { name: 'Dirección' },
      parkingMinutes: 15,
      walkingMinutes: 10,
      followUpRequired: true,
    }),
    make('virtual', 'Comité ejecutivo virtual', second, 45, {
      mode: 'virtual',
      priority: 'medium',
      responsible: { name: 'Secretaría Ejecutiva' },
    }),
    make('physical', 'Visita estratégica', physical, 75, {
      mode: 'in_person',
      locationName: 'Sede operativa',
      destination: {
        name: 'Sede operativa',
        address: 'Acceso principal',
      },
      priority: 'critical',
      parkingMinutes: 15,
      walkingMinutes: 10,
    }),
    make('followup', 'Bloque de seguimiento', follow, 45, {
      mode: 'virtual',
      priority: 'low',
      followUpRequired: true,
      responsible: { name: 'Dirección' },
    }),
  ];
}
