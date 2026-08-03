import type { MobilityDashboardRequestR3, MobilityDashboardSnapshotR3 } from '../domain/mobilityR3';
import {
  getMobilityEstimateR3,
  mobilityMeetingR3,
  mobilitySnapshotsR3,
  mobilityUpcomingTransfersR3,
} from '../data/mobilityR3MockData';
import { timeToMinutesR3 } from './mobilityEngineR3';
import type { MobilityProviderR3 } from './mobilityProviderR3';

const requireIsoTimeR3 = (value: string, field: string): number => {
  const timestamp = Date.parse(value);
  if (!value.includes('T') || !Number.isFinite(timestamp)) {
    throw new Error(`${field} debe ser un timestamp ISO válido`);
  }
  return timestamp;
};

const projectTelemetryR3 = (currentTime: string) => {
  let dayOffset = 0;
  let previousTemplateMinutes: number | undefined;
  const normalizedTemplateMinutes = mobilitySnapshotsR3.map(({ capturedAt }) => {
    const templateMinutes = timeToMinutesR3(capturedAt);
    if (previousTemplateMinutes !== undefined && templateMinutes < previousTemplateMinutes) dayOffset += 1440;
    previousTemplateMinutes = templateMinutes;
    return templateMinutes + dayOffset;
  });
  const anchorMinutes = normalizedTemplateMinutes[normalizedTemplateMinutes.length - 1];
  const currentTimestamp = requireIsoTimeR3(currentTime, 'request.currentTime');

  return mobilitySnapshotsR3.map((item, index) => ({
    ...item,
    capturedAt: index === mobilitySnapshotsR3.length - 1
      ? currentTime
      : new Date(currentTimestamp + (normalizedTemplateMinutes[index] - anchorMinutes) * 60_000).toISOString(),
  }));
};

const projectMeetingTimeR3 = (
  templateTime: string,
  templateAnchorTime: string,
  meetingStartTime: string,
): string => {
  if (templateTime === templateAnchorTime) return meetingStartTime;
  const templateMinutes = timeToMinutesR3(templateTime);
  const anchorMinutes = timeToMinutesR3(templateAnchorTime);
  const offsetMinutes = templateMinutes < anchorMinutes
    ? templateMinutes + 1440 - anchorMinutes
    : templateMinutes - anchorMinutes;
  return new Date(requireIsoTimeR3(meetingStartTime, 'request.meetingStartTime') + offsetMinutes * 60_000).toISOString();
};

export class MockMobilityProviderR3 implements MobilityProviderR3 {
  async getDashboardSnapshot(request: MobilityDashboardRequestR3): Promise<MobilityDashboardSnapshotR3> {
    requireIsoTimeR3(request.currentTime, 'request.currentTime');
    requireIsoTimeR3(request.meetingStartTime, 'request.meetingStartTime');
    const estimate = getMobilityEstimateR3(request.trafficProfile);
    return {
      metadata: {
        providerMode: 'simulation',
        providerName: 'Proveedor cartográfico pendiente',
        generatedAt: request.currentTime,
        isStale: false,
        sourceStatus: 'ready',
      },
      currentTime: request.currentTime,
      origin: request.origin,
      meeting: {
        ...mobilityMeetingR3,
        startTime: request.meetingStartTime,
        destination: request.destination,
      },
      estimate: {
        ...estimate,
        parkingMinutes: request.parkingMinutes,
        walkingMinutes: request.walkingMinutes,
        preparationMinutes: request.preparationMinutes,
        alternativeRoutes: request.includeAlternatives ? estimate.alternativeRoutes : [],
      },
      telemetry: projectTelemetryR3(request.currentTime),
      upcomingTransfers: mobilityUpcomingTransfersR3.map((item) => ({
        ...item,
        time: projectMeetingTimeR3(item.time, mobilityMeetingR3.startTime, request.meetingStartTime),
        nextMeeting: item.nextMeeting ? {
          ...item.nextMeeting,
          startTime: projectMeetingTimeR3(
            item.nextMeeting.startTime,
            mobilityMeetingR3.startTime,
            request.meetingStartTime,
          ),
        } : undefined,
      })),
    };
  }
}
