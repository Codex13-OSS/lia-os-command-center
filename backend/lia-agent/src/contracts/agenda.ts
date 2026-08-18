export type AgendaPriority =
  | 'low'
  | 'medium'
  | 'high'
  | 'critical';

export type AgendaEventStatus =
  | 'draft'
  | 'scheduled'
  | 'confirmed'
  | 'completed'
  | 'cancelled'
  | 'postponed';

export type AgendaEventMode =
  | 'in_person'
  | 'virtual'
  | 'hybrid';

export type AgendaAttendeeResponse =
  | 'pending'
  | 'accepted'
  | 'tentative'
  | 'declined';

export type AgendaEventSource =
  | 'local'
  | 'migrated_v1'
  | 'external';

export type AgendaRecurrence =
  | {
      frequency: 'none';
    }
  | {
      frequency: 'daily' | 'weekly' | 'monthly';
      interval: number;
      count?: number;
      until?: string;
      byWeekday?: number[];
      exceptions?: string[];
    };

export type AgendaDestination = {
  name: string;
  address?: string;
  latitude?: number;
  longitude?: number;
  mapX?: number;
  mapY?: number;
};

export type AgendaResponsible = {
  id?: string;
  name: string;
  email?: string;
};

export type AgendaAttendee = {
  id?: string;
  name: string;
  email?: string;
  role?: string;
  response: AgendaAttendeeResponse;
};

export type AgendaEvent = {
  id: string;
  title: string;
  startTime: string;
  endTime: string;
  timezone: string;
  mode: AgendaEventMode;
  locationName?: string;
  destination?: AgendaDestination;
  priority: AgendaPriority;
  status: AgendaEventStatus;
  attendees: AgendaAttendee[];
  responsible: AgendaResponsible;
  objective?: string;
  notes?: string;
  preparationMinutes: number;
  parkingMinutes: number;
  walkingMinutes: number;
  followUpRequired: boolean;
  recurrence: AgendaRecurrence;
  createdAt: string;
  updatedAt: string;
  source: AgendaEventSource;
};

export type AgendaReadState =
  | 'unconfigured'
  | 'available'
  | 'unavailable';

export type AgendaContextSnapshot = {
  ok: true;
  service: 'lia-agent-backend';
  integration: 'agenda';
  mode: 'read_only';
  state: AgendaReadState;
  timezone: string;
  readOnly: true;
  realActionsEnabled: false;
  hermesDirectAccess: false;
  sourceOfTruth: 'lia';
  eventCount: number;
  events: AgendaEvent[];
};

export function createAgendaContextSnapshot(
  state: AgendaReadState = 'unconfigured',
  events: AgendaEvent[] = [],
  timezone = 'America/Mexico_City',
): AgendaContextSnapshot {
  return {
    ok: true,
    service: 'lia-agent-backend',
    integration: 'agenda',
    mode: 'read_only',
    state,
    timezone,
    readOnly: true,
    realActionsEnabled: false,
    hermesDirectAccess: false,
    sourceOfTruth: 'lia',
    eventCount: events.length,
    events: events.map((event) => ({
      ...event,
      attendees: event.attendees.map((attendee) => ({ ...attendee })),
      responsible: { ...event.responsible },
      ...(event.destination
        ? { destination: { ...event.destination } }
        : {}),
      recurrence: event.recurrence.frequency === 'none'
        ? { frequency: 'none' }
        : {
            ...event.recurrence,
            ...(event.recurrence.byWeekday
              ? { byWeekday: [...event.recurrence.byWeekday] }
              : {}),
            ...(event.recurrence.exceptions
              ? { exceptions: [...event.recurrence.exceptions] }
              : {}),
          },
    })),
  };
}
