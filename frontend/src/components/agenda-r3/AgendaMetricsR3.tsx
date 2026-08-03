import type { AgendaEventOccurrenceR3 } from '../../domain/agendaRecurrenceR3';
import type {
  AgendaConflictR3,
  AgendaFreeWindowR3,
} from '../../selectors/agendaSelectorsR3';

const TZ = 'America/Mexico_City';

const time = (iso: string) => new Intl.DateTimeFormat('en-US', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: true,
  timeZone: TZ,
}).format(new Date(iso)).replace(/\s?(AM|PM)$/i, ' $1').toUpperCase();

type Props = {
  events: AgendaEventOccurrenceR3[];
  next?: AgendaEventOccurrenceR3;
  conflicts: AgendaConflictR3[];
  free?: AgendaFreeWindowR3;
  workdayState: 'before' | 'active' | 'after' | 'other-day';
  workdayStartTime: string;
  workdayEndTime: string;
};

export function AgendaMetricsR3({
  events,
  next,
  conflicts,
  free,
  workdayState,
  workdayStartTime,
  workdayEndTime,
}: Props) {
  const workdayStart = Date.parse(workdayStartTime);
  const workdayEnd = Date.parse(workdayEndTime);

  const minutes = events.reduce((total, event) => {
    const start = Math.max(
      Date.parse(event.occurrenceStartTime),
      workdayStart,
    );
    const end = Math.min(
      Date.parse(event.occurrenceEndTime),
      workdayEnd,
    );

    return total + Math.max(0, end - start) / 60000;
  }, 0);

  const load = minutes === 0
    ? 'libre'
    : minutes < 180
      ? 'ligera'
      : minutes < 360
        ? 'media'
        : 'alta';

  const hours = minutes === 0
    ? '0 h'
    : `${(minutes / 60).toFixed(1)} h`;

  const freeLabel = workdayState === 'after'
    ? 'Jornada finalizada'
    : workdayState === 'before'
      ? 'Pendiente de inicio'
      : free
        ? `${time(free.startTime)}–${time(free.endTime)}`
        : 'Sin ventana disponible hoy';

  return <div className="lia-agenda-r3-metrics">
    <article>
      <span>Siguiente cita</span>
      <strong>
        {next
          ? `${time(next.occurrenceStartTime)} · ${next.event.title}`
          : 'Sin citas próximas'}
      </strong>
    </article>
    <article>
      <span>Carga del día</span>
      <strong>{hours} · {load}</strong>
    </article>
    <article className={conflicts.length ? 'is-alert' : ''}>
      <span>Conflictos</span>
      <strong>{conflicts.length}</strong>
    </article>
    <article>
      <span>Próxima ventana libre</span>
      <strong>{freeLabel}</strong>
    </article>
  </div>;
}
