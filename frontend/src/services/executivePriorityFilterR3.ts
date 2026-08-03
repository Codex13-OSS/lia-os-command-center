import type {
  ExecutivePriorityCategoryR3,
  ExecutivePriorityInputR3,
  ExecutivePriorityItemR3,
  ExecutivePriorityLevelR3,
  ExecutivePriorityPresentationR3,
} from '../domain/executivePriorityR3';
import type { MobilitySourceStatus, MobilityUpcomingTransferR3 } from '../domain/mobilityR3';
import { timeToMinutesR3 } from './mobilityEngineR3';

const levelBaseR3: Record<ExecutivePriorityLevelR3, number> = {
  critical: 100,
  high: 70,
  normal: 40,
  low: 10,
};

const levelOrderR3: Record<ExecutivePriorityLevelR3, number> = {
  critical: 0,
  high: 1,
  normal: 2,
  low: 3,
};

const providerCriticalStatusesR3: readonly MobilitySourceStatus[] = [
  'error',
  'missing_origin',
  'missing_destination',
  'no_route',
  'provider_not_configured',
];

const safeTimeToMinutesR3 = (time?: string): number => {
  if (!time) return Number.POSITIVE_INFINITY;
  try {
    return timeToMinutesR3(time);
  } catch {
    return Number.POSITIVE_INFINITY;
  }
};

const scoreR3 = (
  level: ExecutivePriorityLevelR3,
  actionRequired: boolean,
  proximityMinutes?: number,
  trafficDelayMinutes = 0,
  marginMinutes?: number,
): number => levelBaseR3[level]
  + (actionRequired ? 14 : 0)
  + (proximityMinutes !== undefined && proximityMinutes <= 90 ? Math.max(0, 18 - Math.floor(proximityMinutes / 10)) : 0)
  + (trafficDelayMinutes >= 10 ? Math.min(15, trafficDelayMinutes) : 0)
  + (marginMinutes !== undefined && marginMinutes <= 15 ? Math.max(0, 16 - marginMinutes) : 0);

const itemR3 = (
  id: string,
  category: ExecutivePriorityCategoryR3,
  level: ExecutivePriorityLevelR3,
  title: string,
  actionRequired: boolean,
  options: { detail?: string; dueTime?: string; proximityMinutes?: number; trafficDelayMinutes?: number; marginMinutes?: number } = {},
): ExecutivePriorityItemR3 => ({
  id,
  category,
  level,
  title,
  detail: options.detail,
  actionRequired,
  dueTime: options.dueTime,
  score: scoreR3(level, actionRequired, options.proximityMinutes, options.trafficDelayMinutes, options.marginMinutes),
});

const sortPriorityR3 = (left: ExecutivePriorityItemR3, right: ExecutivePriorityItemR3): number =>
  levelOrderR3[left.level] - levelOrderR3[right.level]
  || Number(right.actionRequired) - Number(left.actionRequired)
  || safeTimeToMinutesR3(left.dueTime) - safeTimeToMinutesR3(right.dueTime)
  || right.score - left.score
  || left.id.localeCompare(right.id);

const classifyTransferR3 = (transfer: MobilityUpcomingTransferR3): ExecutivePriorityLevelR3 => {
  const status = transfer.status.toUpperCase();
  if (status.includes('NO LLEG') || status.includes('TARDE')) return 'critical';
  if (transfer.risk === 'amber' || status.includes('SALIR')) return 'high';
  if (transfer.risk === 'green') return 'normal';
  return 'low';
};

export function createExecutivePriorityViewR3(input: ExecutivePriorityInputR3): ExecutivePriorityPresentationR3 {
  const { presentation, sourceStatus } = input;
  const prediction = presentation?.prediction;
  const items: ExecutivePriorityItemR3[] = [];

  if (providerCriticalStatusesR3.includes(sourceStatus)) {
    items.push(itemR3(`provider-${sourceStatus}`, 'system', 'critical', 'Movilidad no disponible', true, { detail: sourceStatus }));
  } else if (sourceStatus === 'stale') {
    items.push(itemR3('provider-stale', 'system', 'high', 'Movilidad pendiente de actualización', true));
  }

  if (prediction) {
    const proximity = prediction.availableMinutes;
    const mobilityLevel: ExecutivePriorityLevelR3 = prediction.status === 'late'
      ? 'critical'
      : prediction.status === 'leave_now' || prediction.status === 'leave_soon'
        ? 'high'
        : proximity <= 90 || prediction.marginMinutes <= 15 || prediction.trafficDelayMinutes >= 10 || prediction.punctualityProbability < 90
          ? 'high'
          : 'normal';
    items.push(itemR3('next-meeting', 'meeting', proximity < 0 ? 'critical' : proximity <= 90 ? 'high' : 'normal', prediction.meeting.title, proximity <= 90, {
      dueTime: prediction.meeting.startTime,
      proximityMinutes: proximity,
    }));
    items.push(itemR3('mobility-status', 'mobility', mobilityLevel, presentation.statusLabel, mobilityLevel !== 'normal', {
      detail: `Margen ${prediction.marginMinutes} min`,
      dueTime: prediction.recommendedDepartureTime,
      proximityMinutes: proximity,
      trafficDelayMinutes: prediction.trafficDelayMinutes,
      marginMinutes: prediction.marginMinutes,
    }));
  }

  items.push(itemR3('decisions-pending', 'decision', input.decisionsPending > 0 ? 'high' : 'normal', `${input.decisionsPending} decisiones pendientes`, input.decisionsPending > 0));
  items.push(itemR3('critical-risks', 'risk', input.criticalRisks > 0 ? 'critical' : 'normal', `${input.criticalRisks} riesgos críticos`, input.criticalRisks > 0));

  input.activities.forEach((activity) => {
    const level: ExecutivePriorityLevelR3 = activity.tone === 'red'
      ? 'critical'
      : activity.actionRequired || (activity.dueInMinutes !== undefined && activity.dueInMinutes <= 90)
        ? 'high'
        : activity.routine
          ? 'low'
          : 'normal';
    items.push(itemR3(`activity-${activity.id}`, 'activity', level, activity.title, activity.actionRequired, {
      detail: activity.detail,
      proximityMinutes: activity.dueInMinutes,
    }));
  });

  const sorted = [...items].sort(sortPriorityR3);
  const priorityTransfers = [...(presentation?.upcomingTransfers ?? [])]
    .filter((transfer) => ['critical', 'high'].includes(classifyTransferR3(transfer)))
    .sort((left, right) => safeTimeToMinutesR3(left.time) - safeTimeToMinutesR3(right.time) || left.id.localeCompare(right.id));
  const hiddenTransfers = [...(presentation?.upcomingTransfers ?? [])].filter((transfer) => !priorityTransfers.some(({ id }) => id === transfer.id));
  const visibleActivities = input.activities.filter((activity) => {
    const priorityItem = sorted.find(({ id }) => id === `activity-${activity.id}`);
    return priorityItem?.level === 'critical' || priorityItem?.level === 'high';
  });
  const hiddenActivities = input.activities.filter((activity) => !visibleActivities.some(({ id }) => id === activity.id));
  const firstDelay = presentation?.telemetry[0]?.delayMinutes ?? 0;
  const currentDelay = prediction?.trafficDelayMinutes ?? 0;
  const telemetryLength = presentation?.telemetry.length ?? 0;
  const previousDelay = presentation?.telemetry[Math.max(0, telemetryLength - 2)]?.delayMinutes ?? currentDelay;
  const trafficTrend = currentDelay > previousDelay ? 'aumentando' : currentDelay < previousDelay ? 'disminuyendo' : 'estable';

  return {
    criticalItems: sorted.filter(({ level }) => level === 'critical'),
    highItems: sorted.filter(({ level }) => level === 'high'),
    hiddenNormalCount: sorted.filter(({ level }) => level === 'normal').length,
    hiddenLowCount: sorted.filter(({ level }) => level === 'low').length,
    metrics: [
      {
        id: 'next-meeting',
        label: 'PRÓXIMA REUNIÓN',
        stateLabel: !prediction ? 'PENDIENTE' : prediction.availableMinutes < 0 ? 'ATRASADA' : 'ACTIVO',
        value: prediction?.meeting.startTime ?? '—',
        description: prediction?.meeting.title ?? 'Pendiente',
        icon: 'metrica-reunion',
        level: !prediction
          ? 'normal'
          : prediction.availableMinutes < 0
            ? 'critical'
            : prediction.availableMinutes <= 90
              ? 'high'
              : 'normal',
      },
      {
        id: 'departure',
        label: 'SALIDA RECOMENDADA',
        stateLabel: prediction?.status === 'on_time'
          ? 'EN TIEMPO'
          : prediction?.status === 'leave_soon'
            ? 'PRIORIDAD'
            : prediction?.status === 'leave_now'
              ? 'SALIR AHORA'
              : prediction?.status === 'late'
                ? 'ATRASO'
                : 'PENDIENTE',
        value: prediction?.recommendedDepartureTime ?? '—',
        description: prediction
          ? prediction.marginMinutes > 0
            ? `En ${prediction.marginMinutes} min`
            : prediction.marginMinutes === 0
              ? 'Ahora'
              : `Hace ${Math.abs(prediction.marginMinutes)} min`
          : 'Pendiente',
        icon: 'reloj',
        level: prediction?.status === 'leave_soon'
          ? 'high'
          : prediction?.status === 'leave_now' || prediction?.status === 'late'
            ? 'critical'
            : 'normal',
      },
      {
        id: 'decisions',
        label: 'DECISIONES PENDIENTES',
        stateLabel: input.decisionsPending > 0 ? 'PENDIENTES' : 'AL DÍA',
        value: String(input.decisionsPending),
        description: input.decisionsPending > 0 ? 'Validación requerida' : 'Sin decisiones pendientes',
        icon: 'metrica-decision',
        level: input.decisionsPending > 0 ? 'high' : 'normal',
      },
      {
        id: 'risks',
        label: 'RIESGOS CRÍTICOS',
        stateLabel: input.criticalRisks > 0 ? 'ATENCIÓN' : 'SIN RIESGOS',
        value: String(input.criticalRisks),
        description: input.criticalRisks > 0 ? 'Requieren atención' : 'Sin riesgos críticos',
        icon: 'riesgo',
        level: input.criticalRisks > 0 ? 'critical' : 'normal',
      },
    ],
    priorityTransfers,
    hiddenTransfers,
    visibleActivities,
    hiddenActivities,
    showTrafficModule: currentDelay >= 5 && (trafficTrend !== 'estable' || currentDelay >= 10),
    trafficTrend,
    trafficChangeMinutes: currentDelay - firstDelay,
  };
}

export const isProviderPriorityStatusR3 = (status: MobilitySourceStatus): boolean =>
  providerCriticalStatusesR3.includes(status) || status === 'stale';
