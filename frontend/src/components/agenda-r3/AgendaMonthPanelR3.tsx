import type { AgendaEventModeR3, AgendaEventR3, AgendaPriorityR3 } from '../../domain/agendaEventR3';
import type { AgendaEventOccurrenceR3 } from '../../domain/agendaRecurrenceR3';
import { selectEventsForDayR3 } from '../../selectors/agendaSelectorsR3';

const TZ = 'America/Mexico_City';
const key = (date: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
const priorities: Record<AgendaPriorityR3, string> = { low: 'Baja', medium: 'Media', high: 'Alta', critical: 'Crítica' };
const modes: Record<AgendaEventModeR3, string> = { in_person: 'Presencial', virtual: 'Virtual', hybrid: 'Híbrida' };
const appointmentDate = (iso: string) => {
  const date = new Date(iso);
  const shortDate = new Intl.DateTimeFormat('es-MX', { weekday: 'short', day: '2-digit', month: 'short', timeZone: TZ }).format(date).replace(/[.,]/g, '');
  const clock = new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: TZ }).format(date).toUpperCase();
  return `${shortDate.charAt(0).toUpperCase()}${shortDate.slice(1)} · ${clock}`;
};

type Props = { selected: Date; onSelect: (date: Date) => void; events: readonly AgendaEventR3[]; upcoming: AgendaEventOccurrenceR3[]; conflicts: AgendaConflictId[]; onShowAll: () => void };
type AgendaConflictId = { firstEventId: string; secondEventId: string };

export function AgendaMonthPanelR3({ selected, onSelect, events, upcoming, conflicts, onShowAll }: Props) {
  const first = new Date(selected.getFullYear(), selected.getMonth(), 1);
  const offset = (first.getDay() + 6) % 7;
  const cells = Array.from({ length: 42 }, (_, index) => new Date(selected.getFullYear(), selected.getMonth(), index - offset + 1));
  const priorityItems = events.filter(event => event.priority === 'critical' || event.priority === 'high' || event.followUpRequired).slice(0, 3);
  const rawMonth = selected.toLocaleDateString('es-MX', { month: 'long', year: 'numeric' });
  const month = `${rawMonth.charAt(0).toUpperCase()}${rawMonth.slice(1)}`;
  const reason = (event: AgendaEventR3) => {
    const hasConflict = conflicts.some(item => item.firstEventId.startsWith(`${event.id}@`) || item.secondEventId.startsWith(`${event.id}@`));
    return hasConflict ? 'Conflicto' : event.priority === 'critical' ? 'Prioridad crítica' : event.priority === 'high' ? 'Prioridad alta' : 'Seguimiento requerido';
  };

  return <aside className="lia-agenda-r3-month">
    <div className="lia-agenda-r3-month-head"><button type="button" aria-label="Mes anterior" onClick={() => onSelect(new Date(selected.getFullYear(), selected.getMonth() - 1, 1))}>‹</button><h2>{month}</h2><button type="button" aria-label="Mes siguiente" onClick={() => onSelect(new Date(selected.getFullYear(), selected.getMonth() + 1, 1))}>›</button></div>
    <div className="lia-agenda-r3-calendar" role="grid" aria-label="Calendario mensual">{cells.map(date => {
      const dateKey = key(date), count = selectEventsForDayR3(events, dateKey, TZ).length;
      return <button type="button" role="gridcell" key={dateKey} aria-selected={dateKey === key(selected)} className={`${date.getMonth() !== selected.getMonth() ? 'is-out ' : ''}${dateKey === key(new Date()) ? 'is-today ' : ''}${dateKey === key(selected) ? 'is-selected' : ''}`} onClick={() => onSelect(date)}><span>{date.getDate()}</span><i>{Array.from({ length: Math.min(3, count) }, (_, index) => <em key={index} />)}</i></button>;
    })}</div>
    <div className="lia-agenda-r3-month-lists">
      <section><h3>Próximas citas</h3><div className="lia-agenda-r3-compact-list">{upcoming.slice(0, 3).map(occurrence => <article key={occurrence.occurrenceId}><b title={occurrence.event.title}>{occurrence.event.title}</b><time>{appointmentDate(occurrence.occurrenceStartTime)}</time><span>{priorities[occurrence.event.priority]} · {modes[occurrence.event.mode]}</span></article>)}</div><button type="button" onClick={onShowAll}>Ver todas</button></section>
      <section><h3>Atención prioritaria</h3><div className="lia-agenda-r3-compact-list">{priorityItems.map(event => <article key={event.id}><b title={event.title}>{event.title}</b><span>{reason(event)}</span></article>)}</div></section>
    </div>
  </aside>;
}
