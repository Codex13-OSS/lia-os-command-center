import type {
  MobilityLocationR3,
  MobilityMeetingR3,
  MobilityPredictionR3,
  MobilityDashboardSnapshotR3,
  MobilityPresentationR3,
  MobilityPunctualityStatus,
  MobilityRouteEstimateR3,
} from '../domain/mobilityR3';

export const timeToMinutesR3 = (time: string): number => {
  const isoTimestamp = Date.parse(time);
  if (time.includes('T') && Number.isFinite(isoTimestamp)) return isoTimestamp / 60_000;

  const match = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (match) {
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (hours <= 23 && minutes <= 59) return hours * 60 + minutes;
  }

  throw new Error(`Tiempo de movilidad inválido: ${time}`);
};

export const minutesToTimeR3 = (totalMinutes: number): string => {
  const normalized = ((totalMinutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(normalized / 60)).padStart(2, '0')}:${String(normalized % 60).padStart(2, '0')}`;
};

export const calculateAvailableMinutesR3 = (currentTime: string, meetingTime: string): number =>
  {
    const difference = timeToMinutesR3(meetingTime) - timeToMinutesR3(currentTime);
    return difference >= 0 ? Math.ceil(difference) : Math.floor(difference);
  };

export const calculateRequiredMinutesR3 = (estimate: MobilityRouteEstimateR3): number =>
  estimate.trafficDurationMinutes
  + estimate.parkingMinutes
  + estimate.walkingMinutes
  + estimate.preparationMinutes;

export const calculateTrafficDelayR3 = (estimate: MobilityRouteEstimateR3): number =>
  estimate.trafficDurationMinutes - estimate.normalDurationMinutes;

export const calculateMarginR3 = (availableMinutes: number, requiredMinutes: number): number =>
  availableMinutes - requiredMinutes;

export const calculateRecommendedDepartureR3 = (meetingTime: string, requiredMinutes: number): string => {
  const meetingTimestamp = Date.parse(meetingTime);
  if (meetingTime.includes('T') && Number.isFinite(meetingTimestamp)) {
    return new Date(meetingTimestamp - requiredMinutes * 60_000).toISOString();
  }
  return minutesToTimeR3(timeToMinutesR3(meetingTime) - requiredMinutes);
};

export const calculateEstimatedArrivalR3 = (
  currentTime: string,
  estimate: MobilityRouteEstimateR3,
): string => {
  const journeyMinutes = estimate.trafficDurationMinutes
    + estimate.parkingMinutes
    + estimate.walkingMinutes;
  const currentTimestamp = Date.parse(currentTime);
  if (currentTime.includes('T') && Number.isFinite(currentTimestamp)) {
    return new Date(currentTimestamp + journeyMinutes * 60_000).toISOString();
  }
  return minutesToTimeR3(timeToMinutesR3(currentTime) + journeyMinutes);
};

export const classifyPunctualityStatusR3 = (marginMinutes: number | undefined): MobilityPunctualityStatus => {
  if (marginMinutes === undefined || !Number.isFinite(marginMinutes)) return 'pending';
  if (marginMinutes > 15) return 'on_time';
  if (marginMinutes >= 6) return 'leave_soon';
  if (marginMinutes >= 0) return 'leave_now';
  return 'late';
};

const statusLabelsR3: Record<MobilityPunctualityStatus, string> = {
  on_time: 'EN TIEMPO',
  leave_soon: 'SALIR PRONTO',
  leave_now: 'SALIR AHORA',
  late: 'NO LLEGAMOS',
  pending: 'PENDIENTE DE CÁLCULO',
};

export const calculatePunctualityProbabilityR3 = (marginMinutes: number): number => {
  // Heurística determinista inicial; será sustituida por un modelo calibrado con datos autorizados.
  return Math.min(99, Math.max(5, Math.round(72 + marginMinutes * 1.6)));
};

export const createMobilityPredictionR3 = ({
  currentTime,
  origin,
  meeting,
  estimate,
}: {
  currentTime: string;
  origin: MobilityLocationR3;
  meeting: MobilityMeetingR3;
  estimate: MobilityRouteEstimateR3;
}): MobilityPredictionR3 => {
  const availableMinutes = calculateAvailableMinutesR3(currentTime, meeting.startTime);
  const requiredMinutes = calculateRequiredMinutesR3(estimate);
  const marginMinutes = calculateMarginR3(availableMinutes, requiredMinutes);

  return {
    origin,
    meeting,
    estimate,
    availableMinutes,
    requiredMinutes,
    marginMinutes,
    recommendedDepartureTime: calculateRecommendedDepartureR3(meeting.startTime, requiredMinutes),
    estimatedArrivalTime: calculateEstimatedArrivalR3(currentTime, estimate),
    trafficDelayMinutes: calculateTrafficDelayR3(estimate),
    punctualityProbability: calculatePunctualityProbabilityR3(marginMinutes),
    status: classifyPunctualityStatusR3(marginMinutes),
  };
};

export const createMobilityPresentationR3 = (
  snapshot: MobilityDashboardSnapshotR3,
  prediction: MobilityPredictionR3,
): MobilityPresentationR3 => {
  const lastIndex = snapshot.telemetry.length - 1;
  const telemetry = snapshot.telemetry.map((item, index) => index === lastIndex ? {
    ...item,
    normalDurationMinutes: prediction.estimate.normalDurationMinutes,
    trafficDurationMinutes: prediction.estimate.trafficDurationMinutes,
    delayMinutes: prediction.trafficDelayMinutes,
    marginMinutes: prediction.marginMinutes,
    punctualityProbability: prediction.punctualityProbability,
    status: prediction.status,
  } : item);
  const riskLabel = prediction.status === 'on_time'
    ? 'BAJO'
    : prediction.status === 'late'
      ? 'ALTO'
      : prediction.status === 'pending'
        ? 'PENDIENTE'
        : 'CONTROLADO';
  const upcomingTransfers = snapshot.upcomingTransfers.map((transfer) => {
    const isMainTransfer = transfer.meeting === prediction.meeting.title
      && transfer.destination === prediction.meeting.destination.name;
    if (!isMainTransfer) return transfer;
    return {
      ...transfer,
      status: statusLabelsR3[prediction.status],
      risk: prediction.status === 'on_time'
        ? 'green' as const
        : prediction.status === 'pending'
          ? 'neutral' as const
          : 'amber' as const,
    };
  });

  return {
    metadata: snapshot.metadata,
    prediction,
    telemetry,
    upcomingTransfers,
    statusLabel: statusLabelsR3[prediction.status],
    riskLabel,
  };
};
