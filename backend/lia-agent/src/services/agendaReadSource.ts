import type {
  AgendaEvent,
  AgendaReadState,
} from '../contracts/agenda.js';

export type AgendaReadResult = {
  state: AgendaReadState;
  timezone: string;
  events: AgendaEvent[];
};

export type AgendaReadSource = {
  read(): Promise<AgendaReadResult>;
};

export function createUnconfiguredAgendaReadSource(): AgendaReadSource {
  return {
    async read() {
      return {
        state: 'unconfigured',
        timezone: 'America/Mexico_City',
        events: [],
      };
    },
  };
}
