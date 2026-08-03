import { useState } from 'react';
import type { CSSProperties } from 'react';
import type { AgendaEventModeR3, AgendaEventSourceR3, AgendaEventStatusR3, AgendaPriorityR3, AgendaTemporalStateR3 } from '../../domain/agendaEventR3';
import type { AgendaEventOccurrenceR3 } from '../../domain/agendaRecurrenceR3';
import { getAgendaTemporalStateR3 } from '../../selectors/agendaSelectorsR3';

const TZ = 'America/Mexico_City';
const priority: Record<AgendaPriorityR3, string> = { low: 'Baja', medium: 'Media', high: 'Alta', critical: 'Crítica' };
const mode: Record<AgendaEventModeR3, string> = { in_person: 'Presencial', virtual: 'Virtual', hybrid: 'Híbrida' };
const status: Record<AgendaEventStatusR3, string> = { draft: 'Borrador', scheduled: 'Programada', confirmed: 'Confirmada', completed: 'Completada', cancelled: 'Cancelada', postponed: 'Pospuesta' };
const temporal: Record<AgendaTemporalStateR3, string> = { upcoming: 'Próxima', in_progress: 'En curso', past: 'Finalizada' };
const source: Record<AgendaEventSourceR3, string> = { seed: 'Demostración', local: 'Local', migrated_v1: 'Migrada', external: 'Externa' };
const time = (iso: string) => new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: TZ }).format(new Date(iso)).toUpperCase();

type Props = { occurrence: AgendaEventOccurrenceR3; conflict: boolean; now: Date; style: CSSProperties };

export function AgendaEventCardR3({ occurrence, conflict, now, style }: Props) {
  const [open, setOpen] = useState(false);
  const event = occurrence.event;
  const minutes = Math.round((Date.parse(occurrence.occurrenceEndTime) - Date.parse(occurrence.occurrenceStartTime)) / 60000);
  const mobility = event.mode === 'virtual' ? 'Movilidad no requerida' : event.mode === 'hybrid' ? 'Híbrida' : event.destination ? 'Presencial' : 'Destino pendiente';
  const place = event.locationName ?? event.destination?.name ?? mode[event.mode];
  return <article className={`lia-agenda-r3-event is-${event.priority}${conflict ? ' has-conflict' : ''}${open ? ' is-open' : ''}`} style={style}>
    <button type="button" className="lia-agenda-r3-event-summary" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      <span>{time(occurrence.occurrenceStartTime)} · {minutes} min</span><strong>{event.title}</strong>
      <small>{place} · {priority[event.priority]} · {temporal[getAgendaTemporalStateR3(occurrence, now)]} · {mobility}</small>
    </button>
    {open && <div className="lia-agenda-r3-event-details">
      <p><b>Objetivo:</b> {event.objective ?? 'Sin objetivo registrado'}</p><p><b>Responsable:</b> {event.responsible.name}</p>
      <p><b>Participantes:</b> {event.attendees.map(attendee => attendee.name).join(', ') || 'Sin participantes'}</p><p><b>Notas:</b> {event.notes ?? 'Sin notas'}</p>
      <p><b>Preparación:</b> {event.preparationMinutes} min · <b>Estacionamiento:</b> {event.parkingMinutes} min · <b>Caminata:</b> {event.walkingMinutes} min</p>
      <p><b>Seguimiento:</b> {event.followUpRequired ? 'Requerido' : 'No requerido'} · <b>Fuente:</b> {source[event.source]} · <b>Estado:</b> {status[event.status]}</p>
    </div>}
  </article>;
}
