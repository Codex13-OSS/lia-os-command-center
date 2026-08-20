const dayLabelsR3 = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'] as const;
const monthLabelsR3 = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'] as const;


export function formatExecutiveDateR3(date: Date): string {
  return `${dayLabelsR3[date.getDay()]} ${String(date.getDate()).padStart(2, '0')} ${monthLabelsR3[date.getMonth()]} ${date.getFullYear()}`;
}

export function formatClockTimeR3(date: Date): string {
  const hours = date.getHours();
  const period = hours >= 12 ? 'PM' : 'AM';
  const displayHours = hours % 12 || 12;
  return `${String(displayHours).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')} ${period}`;
}

export function addDashboardMinutesR3(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}

export function differenceInDisplayMinutesR3(target: Date, reference: Date): number {
  const difference = (target.getTime() - reference.getTime()) / 60_000;
  return difference >= 0 ? Math.ceil(difference) : Math.floor(difference);
}

export function formatActivityTemporalDetailR3(
  target: Date,
  reference: Date,
  mode: 'past' | 'scheduled',
): string {
  const difference = differenceInDisplayMinutesR3(target, reference);
  const time = formatClockTimeR3(target);

  if (mode === 'past') return difference === 0 ? `${time} · Ahora` : `${time} · Hace ${Math.abs(difference)} min`;
  if (difference > 0) return `${time} · Inicia en ${difference} min`;
  if (difference === 0) return `${time} · Inicia ahora`;
  return `${time} · Inició hace ${Math.abs(difference)} min`;
}

export function formatDashboardTimeR3(time: string): string {
  const parsedTime = new Date(time);
  if (time.includes('T') && !Number.isNaN(parsedTime.getTime())) return formatClockTimeR3(parsedTime);
  if (!/^\d{1,2}:\d{2}$/.test(time)) return time;
  const [hours, minutes] = time.split(':').map(Number);
  if (hours > 23 || minutes > 59) return time;
  const period = hours >= 12 ? 'PM' : 'AM';
  return `${hours % 12 || 12}:${String(minutes).padStart(2, '0')} ${period}`;
}
