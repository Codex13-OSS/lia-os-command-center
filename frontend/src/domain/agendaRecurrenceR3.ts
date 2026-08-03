import type { AgendaEventR3 } from './agendaEventR3';

export type AgendaRecurrenceR3 = { frequency: 'none' } | { frequency: 'daily' | 'weekly' | 'monthly'; interval: number; count?: number; until?: string; byWeekday?: number[]; exceptions?: string[] };
export interface AgendaEventOccurrenceR3 { occurrenceId: string; masterEventId: string; occurrenceStartTime: string; occurrenceEndTime: string; event: AgendaEventR3 }
export type AgendaRecurrenceValidationR3 = { success: true; recurrence: AgendaRecurrenceR3 } | { success: false; errors: Array<{ path: string; message: string }> };
export interface ZonedDatePartsR3 { year: number; month: number; day: number; hour: number; minute: number; second: number; weekday: number }
const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;
export const AGENDA_RECURRENCE_SAFETY_LIMIT_R3 = 10000;

export function isValidAgendaTimezoneR3(timezone: string): boolean { try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(); return true; } catch { return false; } }
export function getZonedDatePartsR3(value: Date | string, timezone: string): ZonedDatePartsR3 {
  if (!isValidAgendaTimezoneR3(timezone)) throw new RangeError('Invalid timezone');
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new RangeError('Invalid date');
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, calendar: 'gregory', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short' }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find(p => p.type === type)?.value);
  const weekdayName = parts.find(p => p.type === 'weekday')?.value ?? '';
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute'), second: get('second'), weekday: ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(weekdayName) };
}
export function zonedDateTimeToIsoR3(parts: Omit<ZonedDatePartsR3, 'weekday'>, timezone: string): string {
  if (!isValidAgendaTimezoneR3(timezone)) throw new RangeError('Invalid timezone');
  const desired = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  let candidate = desired;
  for (let i = 0; i < 4; i += 1) {
    const actual = getZonedDatePartsR3(new Date(candidate), timezone);
    const represented = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second);
    candidate += desired - represented;
  }
  const check = getZonedDatePartsR3(new Date(candidate), timezone);
  if (check.year !== parts.year || check.month !== parts.month || check.day !== parts.day || check.hour !== parts.hour || check.minute !== parts.minute || check.second !== parts.second) throw new RangeError('Nonexistent or ambiguous local time');
  return new Date(candidate).toISOString();
}
const localDate = (key: string): { year: number; month: number; day: number } => { if (!DATE_KEY.test(key)) throw new RangeError('Invalid local date'); const [year, month, day] = key.split('-').map(Number); const d = new Date(Date.UTC(year, month - 1, day)); if (d.getUTCFullYear() !== year || d.getUTCMonth() + 1 !== month || d.getUTCDate() !== day) throw new RangeError('Invalid local date'); return { year, month, day }; };
const keyFromUtc = (d: Date): string => `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
export function getAgendaLocalDateKeyR3(value: Date | string, timezone: string): string { const p = getZonedDatePartsR3(value, timezone); return `${p.year}-${String(p.month).padStart(2,'0')}-${String(p.day).padStart(2,'0')}`; }
export function addAgendaLocalDaysR3(key: string, days: number): string { const p = localDate(key); return keyFromUtc(new Date(Date.UTC(p.year, p.month - 1, p.day + days))); }
export function addAgendaLocalMonthsR3(key: string, months: number): string { const p = localDate(key); const base = new Date(Date.UTC(p.year, p.month - 1 + months, 1)); const last = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth()+1, 0)).getUTCDate(); return keyFromUtc(new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), Math.min(p.day,last)))); }
export function getAgendaDayBoundsR3(day: string, timezone: string): { startTime: string; endTime: string } { const p = localDate(day); return { startTime: zonedDateTimeToIsoR3({ ...p, hour:0, minute:0, second:0 }, timezone), endTime: zonedDateTimeToIsoR3({ ...localDate(addAgendaLocalDaysR3(day,1)), hour:0, minute:0, second:0 }, timezone) }; }
export function validateAgendaRecurrenceR3(value: unknown): AgendaRecurrenceValidationR3 {
  const errors: Array<{path:string;message:string}> = [];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { success:false, errors:[{path:'$',message:'Debe ser objeto'}] };
  const r = value as Record<string, unknown>;
  if (r.frequency === 'none') return { success:true, recurrence:{frequency:'none'} };
  if (!['daily','weekly','monthly'].includes(String(r.frequency))) errors.push({path:'frequency',message:'Frecuencia inválida'});
  if (!Number.isInteger(r.interval) || (r.interval as number) <= 0) errors.push({path:'interval',message:'Debe ser entero positivo'});
  if (r.count !== undefined && (!Number.isInteger(r.count) || (r.count as number) <= 0)) errors.push({path:'count',message:'Debe ser entero positivo'});
  if (r.until !== undefined && (typeof r.until !== 'string' || !Number.isFinite(Date.parse(r.until)))) errors.push({path:'until',message:'Debe ser ISO válido'});
  let byWeekday: number[] | undefined, exceptions: string[] | undefined;
  if (r.byWeekday !== undefined) { if (!Array.isArray(r.byWeekday) || r.byWeekday.some(v => !Number.isInteger(v) || v < 0 || v > 6)) errors.push({path:'byWeekday',message:'Valores deben estar entre 0 y 6'}); else byWeekday = [...new Set(r.byWeekday as number[])].sort((a,b)=>a-b); }
  if (r.exceptions !== undefined) { if (!Array.isArray(r.exceptions) || r.exceptions.some(v => typeof v !== 'string' || !DATE_KEY.test(v))) errors.push({path:'exceptions',message:'Fechas deben usar YYYY-MM-DD'}); else exceptions = [...new Set(r.exceptions as string[])].sort(); }
  if (errors.length) return {success:false,errors};
  return {success:true, recurrence:{frequency:r.frequency as 'daily'|'weekly'|'monthly',interval:r.interval as number,...(r.count===undefined?{}:{count:r.count as number}),...(r.until===undefined?{}:{until:r.until as string}),...(byWeekday?{byWeekday}:{}),...(exceptions?{exceptions}:{})}};
}
export function expandAgendaRecurrenceR3(event: AgendaEventR3, horizonStart: Date | string, horizonEnd: Date | string): AgendaEventOccurrenceR3[] {
  const hs = new Date(horizonStart).getTime(), he = new Date(horizonEnd).getTime(), masterStart = Date.parse(event.startTime), duration = Date.parse(event.endTime)-masterStart;
  if (!Number.isFinite(hs)||!Number.isFinite(he)||hs>=he) return [];
  const recurrence = event.recurrence; const out: AgendaEventOccurrenceR3[]=[]; const baseParts=getZonedDatePartsR3(event.startTime,event.timezone); const baseKey=getAgendaLocalDateKeyR3(event.startTime,event.timezone); let generated=0;
  const add = (key:string): void => { if (generated >= AGENDA_RECURRENCE_SAFETY_LIMIT_R3) return; const p=localDate(key); let start:string; try { start=zonedDateTimeToIsoR3({...p,hour:baseParts.hour,minute:baseParts.minute,second:baseParts.second},event.timezone); } catch { return; } const ms=Date.parse(start); if (recurrence.frequency!=='none' && recurrence.until && ms>Date.parse(recurrence.until)) return; generated+=1; if (recurrence.frequency!=='none' && recurrence.count && generated>recurrence.count) return; if (recurrence.frequency!=='none' && recurrence.exceptions?.includes(key)) return; if (ms < he && ms+duration > hs) out.push({occurrenceId:`${event.id}@${start}`,masterEventId:event.id,occurrenceStartTime:start,occurrenceEndTime:new Date(ms+duration).toISOString(),event}); };
  if (recurrence.frequency==='none') { add(baseKey); return out; }
  let key=baseKey;
  for (let guard=0; guard<AGENDA_RECURRENCE_SAFETY_LIMIT_R3; guard+=1) {
    const keyStart=Date.parse(zonedDateTimeToIsoR3({...localDate(key),hour:baseParts.hour,minute:baseParts.minute,second:baseParts.second},event.timezone)); if (keyStart>=he || (recurrence.until && keyStart>Date.parse(recurrence.until)) || (recurrence.count && generated>=recurrence.count)) break;
    if (recurrence.frequency==='weekly') { const weekBase=addAgendaLocalDaysR3(baseKey,guard*7*recurrence.interval); const weekdays=recurrence.byWeekday?.length?recurrence.byWeekday:[baseParts.weekday]; for(let d=0;d<7;d+=1){const candidate=addAgendaLocalDaysR3(weekBase,d); if(Date.parse(zonedDateTimeToIsoR3({...localDate(candidate),hour:baseParts.hour,minute:baseParts.minute,second:baseParts.second},event.timezone))>=masterStart && weekdays.includes(getZonedDatePartsR3(zonedDateTimeToIsoR3({...localDate(candidate),hour:12,minute:0,second:0},event.timezone),event.timezone).weekday)) add(candidate);} key=addAgendaLocalDaysR3(weekBase,7*recurrence.interval); }
    else { add(key); key=recurrence.frequency==='daily'?addAgendaLocalDaysR3(key,recurrence.interval):addAgendaLocalMonthsR3(key,recurrence.interval); }
  }
  return out.sort((a,b)=>a.occurrenceStartTime.localeCompare(b.occurrenceStartTime)||a.occurrenceId.localeCompare(b.occurrenceId));
}
