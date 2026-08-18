import type {
  MobilityLocationR3,
  MobilityMeetingR3,
  MobilityRouteEstimateR3,
  MobilitySnapshotR3,
  MobilityTrafficProfile,
  MobilityUpcomingTransferR3,
} from '../domain/mobilityR3';

export const mobilityCurrentTimeR3 = '10:26';

export const mobilityOriginR3: MobilityLocationR3 = {
  id: 'oficina-central',
  name: 'Oficina Central',
  shortAddress: 'Distrito Corporativo',
  mapX: 18,
  mapY: 72,
};

export const mobilityDestinationR3: MobilityLocationR3 = {
  id: 'centro-convenciones',
  name: 'Centro de Convenciones',
  shortAddress: 'Distrito Ejecutivo Norte',
  mapX: 82,
  mapY: 27,
};

export const mobilityMeetingR3: MobilityMeetingR3 = {
  id: 'revision-riesgos',
  title: 'Revisión de riesgos',
  startTime: '11:30',
  destination: mobilityDestinationR3,
};

const baseEstimateR3: MobilityRouteEstimateR3 = {
  distanceKm: 18.4,
  normalDurationMinutes: 26,
  trafficDurationMinutes: 41,
  parkingMinutes: 5,
  walkingMinutes: 4,
  preparationMinutes: 5,
  alternativeRoutes: [
    {
      id: 'alternativa-norte',
      label: 'Alternativa norte simulada',
      distanceKm: 20.1,
      normalDurationMinutes: 29,
      trafficDurationMinutes: 44,
    },
  ],
};

export const mobilityTrafficDurationsR3: Record<MobilityTrafficProfile, number> = {
  fluid: 29,
  current: 41,
  heavy: 55,
};

export const getMobilityEstimateR3 = (profile: MobilityTrafficProfile): MobilityRouteEstimateR3 => ({
  ...baseEstimateR3,
  trafficDurationMinutes: mobilityTrafficDurationsR3[profile],
});

export const mobilitySnapshotsR3: MobilitySnapshotR3[] = [
  { capturedAt: '09:45', normalDurationMinutes: 26, trafficDurationMinutes: 30, delayMinutes: 4, marginMinutes: 20, punctualityProbability: 97, status: 'on_time' },
  { capturedAt: '09:51', normalDurationMinutes: 26, trafficDurationMinutes: 32, delayMinutes: 6, marginMinutes: 18, punctualityProbability: 96, status: 'on_time' },
  { capturedAt: '09:57', normalDurationMinutes: 26, trafficDurationMinutes: 31, delayMinutes: 5, marginMinutes: 19, punctualityProbability: 97, status: 'on_time' },
  { capturedAt: '10:03', normalDurationMinutes: 26, trafficDurationMinutes: 34, delayMinutes: 8, marginMinutes: 16, punctualityProbability: 94, status: 'on_time' },
  { capturedAt: '10:09', normalDurationMinutes: 26, trafficDurationMinutes: 36, delayMinutes: 10, marginMinutes: 14, punctualityProbability: 91, status: 'leave_soon' },
  { capturedAt: '10:15', normalDurationMinutes: 26, trafficDurationMinutes: 38, delayMinutes: 12, marginMinutes: 12, punctualityProbability: 89, status: 'leave_soon' },
  { capturedAt: '10:20', normalDurationMinutes: 26, trafficDurationMinutes: 40, delayMinutes: 14, marginMinutes: 10, punctualityProbability: 87, status: 'leave_soon' },
  { capturedAt: '10:26', normalDurationMinutes: 26, trafficDurationMinutes: 41, delayMinutes: 15, marginMinutes: 9, punctualityProbability: 86, status: 'leave_soon' },
];

export const mobilityUpcomingTransfersR3: MobilityUpcomingTransferR3[] = [
  { id: 'riesgos', time: '11:30', meeting: 'Revisión de riesgos', destination: 'Centro de Convenciones', status: 'SALIR PRONTO', risk: 'amber' },
  { id: 'convenio', time: '14:00', meeting: 'Firma de convenio', destination: 'Torre Financiera', status: 'EN TIEMPO', risk: 'green' },
  { id: 'comite', time: '17:30', meeting: 'Comité ejecutivo', destination: 'Oficina Central', status: 'PENDIENTE DE CÁLCULO', risk: 'neutral' },
];

export const mobilityDashboardRequestR3 = {
  origin: mobilityOriginR3,
  destination: mobilityDestinationR3,
  meetingStartTime: mobilityMeetingR3.startTime,
  currentTime: mobilityCurrentTimeR3,
  departureTime: mobilityCurrentTimeR3,
  parkingMinutes: baseEstimateR3.parkingMinutes,
  walkingMinutes: baseEstimateR3.walkingMinutes,
  preparationMinutes: baseEstimateR3.preparationMinutes,
  includeAlternatives: true,
  trafficProfile: 'current' as const,
};
