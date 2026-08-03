import { useEffect, useMemo, useState } from 'react';
import { ExecutiveShellR3 } from '../executive-r3/ExecutiveShellR3';
import { createAgendaStoreR3 } from '../../store/agendaStoreR3';
import { createAgendaSeedEventsR3 } from '../../data/agendaR3SeedData';
import { useAgendaStoreR3 } from '../../hooks/useAgendaStoreR3';
import {
  getAgendaTemporalStateR3,
  selectAgendaConflictsR3,
  selectAgendaFreeWindowsR3,
  selectAgendaPriorityEventsR3,
  selectEventsForDayR3,
  selectNextAgendaEventR3,
  selectUpcomingAgendaEventsR3,
} from '../../selectors/agendaSelectorsR3';
import { zonedDateTimeToIsoR3 } from '../../domain/agendaRecurrenceR3';
import { AgendaWeekStripR3 } from './AgendaWeekStripR3';
import { AgendaMetricsR3 } from './AgendaMetricsR3';
import { AgendaTimelineR3 } from './AgendaTimelineR3';
import { AgendaMonthPanelR3 } from './AgendaMonthPanelR3';
import { AgendaExecutiveRailR3 } from './AgendaExecutiveRailR3';

const TZ = 'America/Mexico_City';

const key = (date: Date) => new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
}).format(date);

const clockMinutes = (date: Date) => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);

  const value = (type: 'hour' | 'minute') =>
    Number(parts.find(part => part.type === type)?.value ?? 0);

  return value('hour') * 60 + value('minute');
};

const workdayIso = (dateKey: string, hour: number) => {
  const [year, month, day] = dateKey.split('-').map(Number);
  return zonedDateTimeToIsoR3({
    year,
    month,
    day,
    hour,
    minute: 0,
    second: 0,
  }, TZ);
};

type Props = {
  onDashboard: () => void;
  onAgenda: () => void;
  onProjects: () => void;
  onTracking: () => void;
  onDocuments: () => void;
  onAlerts: () => void;
  onLogout: () => void;
};

export function AgendaShellR3(props: Props) {
  const seedAnchor = useMemo(() => new Date(), []);
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const interval = window.setInterval(() => setNow(new Date()), 30000);
    return () => window.clearInterval(interval);
  }, []);

  const store = useMemo(() => createAgendaStoreR3({
    storage: typeof window === 'undefined' ? undefined : window.localStorage,
    seedEvents: createAgendaSeedEventsR3(seedAnchor, TZ),
    timezone: TZ,
  }), [seedAnchor]);

  const snapshot = useAgendaStoreR3(store);
  const [selected, setSelected] = useState(seedAnchor);
  const [all, setAll] = useState(false);
  const [feedback, setFeedback] = useState('');

  const day = key(selected);
  const today = day === key(now);
  const events = selectEventsForDayR3(snapshot.events, day, TZ);

  const workdayStartTime = workdayIso(day, 7);
  const workdayEndTime = workdayIso(day, 20);
  const workdayStart = Date.parse(workdayStartTime);
  const workdayEnd = Date.parse(workdayEndTime);

  const workdayEvents = events.filter(occurrence =>
    Date.parse(occurrence.occurrenceEndTime) > workdayStart
    && Date.parse(occurrence.occurrenceStartTime) < workdayEnd);

  const conflicts = selectAgendaConflictsR3(
    snapshot.events,
    workdayStartTime,
    workdayEndTime,
  );

  const next = selectNextAgendaEventR3(snapshot.events, now);
  const minutesNow = clockMinutes(now);
  const workdayState = !today
    ? 'other-day'
    : minutesNow < 7 * 60
      ? 'before'
      : minutesNow >= 20 * 60
        ? 'after'
        : 'active';

  const nowOffset = workdayState === 'active'
    ? ((minutesNow - 7 * 60) / (13 * 60)) * 100
    : undefined;

  const free = selectAgendaFreeWindowsR3(snapshot.events, {
    day,
    timezone: TZ,
    workdayStart: '07:00',
    workdayEnd: '20:00',
    minimumDurationMinutes: 30,
    includeBuffers: false,
  }).find(window => !today || Date.parse(window.endTime) > now.getTime());

  const importantIds = new Set(
    selectAgendaPriorityEventsR3(snapshot.events).map(event => event.id),
  );

  workdayEvents.forEach((occurrence, index) => {
    const hasConflict = conflicts.some(conflict =>
      conflict.firstEventId === occurrence.occurrenceId
      || conflict.secondEventId === occurrence.occurrenceId);

    if (
      index < 2
      || getAgendaTemporalStateR3(occurrence, now) === 'in_progress'
      || hasConflict
    ) {
      importantIds.add(occurrence.event.id);
    }
  });

  const visible = all
    ? workdayEvents
    : workdayEvents.filter(occurrence =>
      importantIds.has(occurrence.event.id)
      || occurrence.event.followUpRequired);

  const hidden = workdayEvents.length - visible.length;

  const upcoming = selectUpcomingAgendaEventsR3(
    snapshot.events,
    now,
    new Date(now.getTime() + 90 * 86400000),
    { limit: 20 },
  );

  const create = () =>
    setFeedback('Creación de citas disponible en la siguiente fase');

  const rail = <AgendaExecutiveRailR3
    snapshot={snapshot}
    next={next}
    conflicts={conflicts}
    onCreate={create}
    onDashboard={props.onDashboard}
    onDocuments={props.onDocuments}
  />;

  return <ExecutiveShellR3
    {...props}
    activeSection="agenda"
    now={now}
    mainAriaLabel="Agenda ejecutiva"
    mainClassName="lia-agenda-r3-shell"
    rail={rail}
  >
    <header className="lia-agenda-r3-title">
      <div>
        <h1>Agenda</h1>
        <p>Prioridades, reuniones y ventanas ejecutivas</p>
      </div>
      <button type="button" onClick={create}>+ Nueva cita</button>
      <span aria-live="polite">{feedback}</span>
    </header>

    {snapshot.persistenceStatus === 'error' && <div
      className="lia-agenda-r3-error"
      role="alert"
    >
      Error de datos. La información corrupta no fue sobrescrita. {snapshot.warnings.join(' ')}
    </div>}

    <AgendaWeekStripR3
      selected={selected}
      onSelect={date => setSelected(new Date(date))}
      events={snapshot.events}
    />

    <AgendaMetricsR3
      events={workdayEvents}
      next={next}
      conflicts={conflicts}
      free={free}
      workdayState={workdayState}
      workdayStartTime={workdayStartTime}
      workdayEndTime={workdayEndTime}
    />

    <div className="lia-agenda-r3-layout">
      <div className="lia-agenda-r3-day-column">
        <div className="lia-agenda-r3-filter">
          <strong>Jornada ejecutiva</strong>
          {hidden > 0 && <span>{hidden} eventos secundarios ocultos</span>}
          <button type="button" onClick={() => setAll(value => !value)}>
            {all ? 'Ver prioritarios' : 'Ver todos'}
          </button>
        </div>

        <AgendaTimelineR3
          events={visible}
          conflicts={conflicts}
          hidden={hidden}
          workdayState={workdayState}
          next={next}
          firstToday={workdayEvents[0]}
          now={now}
          nowOffset={nowOffset}
        />
      </div>

      <AgendaMonthPanelR3
        selected={selected}
        onSelect={date => setSelected(new Date(date))}
        events={snapshot.events}
        upcoming={upcoming}
        conflicts={conflicts}
        onShowAll={() => setAll(true)}
      />
    </div>
  </ExecutiveShellR3>;
}
