import type { CSSProperties } from 'react';
import type { AgendaEventOccurrenceR3 } from '../../domain/agendaRecurrenceR3';
import type { AgendaConflictR3 } from '../../selectors/agendaSelectorsR3';
import { AgendaEventCardR3 } from './AgendaEventCardR3';

const TZ = 'America/Mexico_City';
const DAY_START = 7 * 60;
const DAY_END = 20 * 60;
const DAY_MINUTES = DAY_END - DAY_START;
const time = (iso: string) => new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: TZ }).format(new Date(iso)).toUpperCase();
const dateTime = (iso: string) => {
  const date = new Date(iso);
  const day = new Intl.DateTimeFormat('es-MX', { weekday: 'short', day: '2-digit', month: 'short', timeZone: TZ }).format(date).replace(/[.,]/g, '');
  return `${day.charAt(0).toUpperCase()}${day.slice(1)} · ${time(iso)}`;
};
const localMinutes = (iso: string) => {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(iso));
  const part = (type: 'hour' | 'minute') => Number(parts.find(item => item.type === type)?.value ?? 0);
  return part('hour') * 60 + part('minute');
};

type LayoutEvent = { occurrence: AgendaEventOccurrenceR3; start: number; end: number; lane: number; laneCount: number };

function layoutEvents(events: AgendaEventOccurrenceR3[]): LayoutEvent[] {
  const ordered = events.map(occurrence => ({ occurrence, start: Math.max(DAY_START, localMinutes(occurrence.occurrenceStartTime)), end: Math.min(DAY_END, localMinutes(occurrence.occurrenceEndTime)) }))
    .filter(item => item.start < DAY_END && item.end > DAY_START && item.start < item.end)
    .sort((a, b) => a.start - b.start || a.end - b.end || a.occurrence.occurrenceId.localeCompare(b.occurrence.occurrenceId));
  const result: LayoutEvent[] = [];
  let cluster: LayoutEvent[] = [];
  let clusterEnd = -1;
  let laneEnds: number[] = [];
  const finishCluster = () => {
    const laneCount = Math.max(1, laneEnds.length);
    cluster.forEach(item => { item.laneCount = laneCount; });
    cluster = [];
    laneEnds = [];
  };
  ordered.forEach(item => {
    if (cluster.length && item.start >= clusterEnd) finishCluster();
    const availableLane = laneEnds.findIndex(end => end <= item.start);
    const lane = availableLane === -1 ? laneEnds.length : availableLane;
    laneEnds[lane] = item.end;
    clusterEnd = Math.max(clusterEnd, item.end);
    const laidOut = { ...item, lane, laneCount: 1 };
    cluster.push(laidOut);
    result.push(laidOut);
  });
  if (cluster.length) finishCluster();
  return result;
}

type Props = {
  events: AgendaEventOccurrenceR3[]; conflicts: AgendaConflictR3[]; hidden: number;
  workdayState: 'before' | 'active' | 'after' | 'other-day'; next?: AgendaEventOccurrenceR3;
  firstToday?: AgendaEventOccurrenceR3; now: Date; nowOffset?: number;
};

export function AgendaTimelineR3({ events, conflicts, hidden, workdayState, next, firstToday, now, nowOffset }: Props) {
  const positioned = layoutEvents(events);
  const contextual = workdayState === 'after'
    ? { title: 'Jornada finalizada', detail: next ? `Siguiente cita: ${next.event.title} · ${dateTime(next.occurrenceStartTime)}` : 'Sin citas próximas' }
    : workdayState === 'before'
      ? { title: 'Jornada aún no inicia', detail: firstToday ? `Primera cita: ${firstToday.event.title} · ${time(firstToday.occurrenceStartTime)}` : next ? `Próxima cita: ${next.event.title} · ${dateTime(next.occurrenceStartTime)}` : 'Sin citas próximas' }
      : undefined;

  return <section className={`lia-agenda-r3-timeline${positioned.length ? '' : ' is-empty'}`} aria-label="Jornada ejecutiva de 07:00 a 20:00">
    <div className="lia-agenda-r3-hours" aria-hidden="true">{Array.from({ length: 14 }, (_, index) => <span key={index}>{String(index + 7).padStart(2, '0')}:00</span>)}</div>
    <div className="lia-agenda-r3-canvas">
      {positioned.length > 0 && workdayState === 'active' && nowOffset !== undefined && <i className="lia-agenda-r3-now" style={{ top: `${nowOffset}%` }}>Ahora</i>}
      {contextual && <div className="lia-agenda-r3-day-state"><strong>{contextual.title}</strong><span>{contextual.detail}</span></div>}
      {positioned.map(({ occurrence, start, end, lane, laneCount }) => {
        const gap = 0.75;
        const width = (100 - gap * (laneCount - 1)) / laneCount;
        const style: CSSProperties = { top: `${((start - DAY_START) / DAY_MINUTES) * 100}%`, height: `${((end - start) / DAY_MINUTES) * 100}%`, left: `${lane * (width + gap)}%`, width: `${width}%` };
        const conflict = conflicts.some(item => item.firstEventId === occurrence.occurrenceId || item.secondEventId === occurrence.occurrenceId);
        return <AgendaEventCardR3 key={occurrence.occurrenceId} occurrence={occurrence} conflict={conflict} now={now} style={style} />;
      })}
      {!positioned.length && !contextual && <div className="lia-agenda-r3-empty"><strong>Día despejado</strong><span>No hay citas programadas</span></div>}
      {hidden > 0 && <p className="lia-agenda-r3-hidden">{hidden} eventos secundarios ocultos</p>}
    </div>
  </section>;
}
