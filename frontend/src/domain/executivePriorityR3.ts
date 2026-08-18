import type {
  MobilityPresentationR3,
  MobilitySourceStatus,
  MobilityUpcomingTransferR3,
} from './mobilityR3';

export type ExecutivePriorityLevelR3 = 'critical' | 'high' | 'normal' | 'low';

export type ExecutivePriorityCategoryR3 =
  | 'mobility'
  | 'meeting'
  | 'decision'
  | 'risk'
  | 'system'
  | 'activity';

export interface ExecutivePriorityItemR3 {
  id: string;
  category: ExecutivePriorityCategoryR3;
  level: ExecutivePriorityLevelR3;
  title: string;
  detail?: string;
  actionRequired: boolean;
  dueTime?: string;
  score: number;
}

export interface ExecutivePriorityViewR3 {
  criticalItems: ExecutivePriorityItemR3[];
  highItems: ExecutivePriorityItemR3[];
  hiddenNormalCount: number;
  hiddenLowCount: number;
}

export interface ExecutiveActivitySourceR3 {
  id: string;
  title: string;
  detail: string;
  icon: string;
  tone: 'blue' | 'red';
  actionRequired: boolean;
  routine?: boolean;
  dueInMinutes?: number;
}

export interface ExecutivePriorityInputR3 {
  presentation: MobilityPresentationR3 | null;
  sourceStatus: MobilitySourceStatus;
  decisionsPending: number;
  criticalRisks: number;
  activities: readonly ExecutiveActivitySourceR3[];
}

export interface ExecutiveMetricR3 {
  id: string;
  label: string;
  stateLabel: string;
  value: string;
  description: string;
  icon: 'metrica-reunion' | 'reloj' | 'metrica-decision' | 'riesgo';
  level: ExecutivePriorityLevelR3;
}

export interface ExecutivePriorityPresentationR3 extends ExecutivePriorityViewR3 {
  metrics: ExecutiveMetricR3[];
  priorityTransfers: MobilityUpcomingTransferR3[];
  hiddenTransfers: MobilityUpcomingTransferR3[];
  visibleActivities: ExecutiveActivitySourceR3[];
  hiddenActivities: ExecutiveActivitySourceR3[];
  showTrafficModule: boolean;
  trafficTrend: 'aumentando' | 'estable' | 'disminuyendo';
  trafficChangeMinutes: number;
}
