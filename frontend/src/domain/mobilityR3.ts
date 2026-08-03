export type MobilityTrafficProfile = 'fluid' | 'current' | 'heavy';

export type MobilityPunctualityStatus = 'on_time' | 'leave_soon' | 'leave_now' | 'late' | 'pending';
export type MobilityProviderMode = 'simulation' | 'live';
export type MobilitySourceStatus =
  | 'loading' | 'ready' | 'stale' | 'error' | 'missing_origin'
  | 'missing_destination' | 'no_route' | 'provider_not_configured';

export interface MobilityCoordinateR3 {
  latitude: number;
  longitude: number;
}

export interface MobilityLocationR3 {
  id: string;
  name: string;
  shortAddress: string;
  coordinate?: MobilityCoordinateR3;
  mapX: number;
  mapY: number;
}

export interface MobilityMeetingR3 {
  id: string;
  title: string;
  startTime: string;
  destination: MobilityLocationR3;
}

export interface MobilityRouteEstimateR3 {
  distanceKm: number;
  normalDurationMinutes: number;
  trafficDurationMinutes: number;
  parkingMinutes: number;
  walkingMinutes: number;
  preparationMinutes: number;
  routeCoordinates?: MobilityCoordinateR3[];
  encodedPolyline?: string;
  alternativeRoutes: MobilityRouteAlternativeR3[];
}

export interface MobilityRouteAlternativeR3 {
  id: string;
  label: string;
  distanceKm: number;
  normalDurationMinutes: number;
  trafficDurationMinutes: number;
  routeCoordinates?: MobilityCoordinateR3[];
  encodedPolyline?: string;
}

export interface MobilitySnapshotR3 {
  capturedAt: string;
  normalDurationMinutes: number;
  trafficDurationMinutes: number;
  delayMinutes: number;
  marginMinutes: number;
  punctualityProbability: number;
  status: MobilityPunctualityStatus;
}

export interface MobilityPredictionR3 {
  origin: MobilityLocationR3;
  meeting: MobilityMeetingR3;
  estimate: MobilityRouteEstimateR3;
  availableMinutes: number;
  requiredMinutes: number;
  marginMinutes: number;
  recommendedDepartureTime: string;
  estimatedArrivalTime: string;
  trafficDelayMinutes: number;
  punctualityProbability: number;
  status: MobilityPunctualityStatus;
}

export interface MobilityUpcomingTransferR3 {
  id: string;
  time: string;
  meeting: string;
  destination: string;
  status: string;
  risk: 'amber' | 'green' | 'neutral';
  previousMeeting?: string;
  origin?: MobilityLocationR3;
  nextMeeting?: MobilityMeetingR3;
  route?: MobilityRouteEstimateR3;
  prediction?: MobilityPredictionR3;
}

export interface MobilityProviderMetadataR3 {
  providerMode: MobilityProviderMode;
  providerName: string;
  generatedAt: string;
  isStale: boolean;
  sourceStatus: MobilitySourceStatus;
}

export interface MobilityDashboardRequestR3 {
  origin: MobilityLocationR3;
  destination: MobilityLocationR3;
  meetingStartTime: string;
  currentTime: string;
  departureTime?: string;
  parkingMinutes: number;
  walkingMinutes: number;
  preparationMinutes: number;
  includeAlternatives: boolean;
  trafficProfile: MobilityTrafficProfile;
}

export interface MobilityDashboardSnapshotR3 {
  metadata: MobilityProviderMetadataR3;
  currentTime: string;
  origin: MobilityLocationR3;
  meeting: MobilityMeetingR3;
  estimate: MobilityRouteEstimateR3;
  telemetry: MobilitySnapshotR3[];
  upcomingTransfers: MobilityUpcomingTransferR3[];
}

export type MobilityRiskLevelR3 = 'low' | 'controlled' | 'high' | 'pending';

export interface MobilityPresentationR3 {
  metadata: MobilityProviderMetadataR3;
  prediction: MobilityPredictionR3;
  telemetry: MobilitySnapshotR3[];
  upcomingTransfers: MobilityUpcomingTransferR3[];
  statusLabel: string;
  riskLabel: string;
}
