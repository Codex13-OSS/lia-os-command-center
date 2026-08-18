import { useEffect, useMemo, useState } from 'react';
import '../../styles/dashboardExecutiveR3.css';
import { DashboardMetricsR3 } from './DashboardMetricsR3';
import { ExecutiveShellR3 } from '../executive-r3/ExecutiveShellR3';
import { LiaExecutiveRailR3 } from './LiaExecutiveRailR3';
import { MobilityMapR3 } from './MobilityMapR3';
import { DashboardMobilityLowerR3 } from './DashboardMobilityLowerR3';
import type { MobilityDashboardRequestR3, MobilityDashboardSnapshotR3, MobilityPresentationR3, MobilitySourceStatus, MobilityTrafficProfile } from '../../domain/mobilityR3';
import { createMobilityPredictionR3, createMobilityPresentationR3 } from '../../services/mobilityEngineR3';
import {
  createMobilityProviderR3,
  initialMobilityDashboardRequestR3,
  MobilityProviderNotConfiguredErrorR3,
  mobilityProviderSelectionR3,
} from '../../services/createMobilityProviderR3';
import { dashboardMetricsR3, recentActivityR3 } from '../../data/dashboardShellR3Data';
import { createExecutivePriorityViewR3 } from '../../services/executivePriorityFilterR3';
import { addDashboardMinutesR3, differenceInDisplayMinutesR3, formatActivityTemporalDetailR3 } from '../../lib/dashboardTemporalR3';
import type { LiaConversationController } from '../lia-r3/liaConversationController';

type DashboardShellR3Props = {
  onDashboard: () => void;
  onAgenda: () => void;
  onProjects: () => void;
  onTracking: () => void;
  onDocuments: () => void;
  onAlerts: () => void;
  onLogout: () => void;
  conversationController?: LiaConversationController;
};

type DashboardScenarioClockR3 = {
  anchor: Date;
  meetingStart: Date;
};

export function DashboardShellR3(props: DashboardShellR3Props) {
  const [mobilityProfile, setMobilityProfile] = useState<MobilityTrafficProfile>('current');
  const [mobilitySnapshot, setMobilitySnapshot] = useState<MobilityDashboardSnapshotR3 | null>(null);
  const [mobilitySourceStatus, setMobilitySourceStatus] = useState<MobilitySourceStatus>('loading');
  const [dashboardNow, setDashboardNow] = useState(() => new Date());
  const [scenarioClock, setScenarioClock] = useState<DashboardScenarioClockR3>(() => ({
    anchor: dashboardNow,
    meetingStart: addDashboardMinutesR3(dashboardNow, 90),
  }));
  const mobilityProvider = useMemo(() => createMobilityProviderR3(mobilityProviderSelectionR3), []);
  let mobilityPresentation: MobilityPresentationR3 | null = null;

  if (mobilitySnapshot) {
    const mobilityPrediction = createMobilityPredictionR3({
      currentTime: mobilitySnapshot.currentTime,
      origin: mobilitySnapshot.origin,
      meeting: mobilitySnapshot.meeting,
      estimate: mobilitySnapshot.estimate,
    });
    mobilityPresentation = createMobilityPresentationR3(mobilitySnapshot, mobilityPrediction);
  }
  const decisionsPending = dashboardMetricsR3.find(({ id }) => id === 'decisions')?.value ?? 0;
  const criticalRisks = dashboardMetricsR3.find(({ id }) => id === 'risks')?.value ?? 0;
  const projectedRecentActivityR3 = useMemo(() => recentActivityR3.map((item) => {
    const targetDate = addDashboardMinutesR3(scenarioClock.anchor, item.temporalOffsetMinutes);
    const detail = formatActivityTemporalDetailR3(targetDate, dashboardNow, item.temporalMode);
    return item.temporalMode === 'scheduled'
      ? { ...item, detail, dueInMinutes: Math.max(0, differenceInDisplayMinutesR3(targetDate, dashboardNow)) }
      : { ...item, detail };
  }), [dashboardNow, scenarioClock.anchor]);
  const priorityView = createExecutivePriorityViewR3({
    presentation: mobilityPresentation,
    sourceStatus: mobilitySourceStatus,
    decisionsPending,
    criticalRisks,
    activities: projectedRecentActivityR3,
  });

  useEffect(() => {
    const interval = window.setInterval(() => {
      const tickNow = new Date();
      const tickIso = tickNow.toISOString();
      setDashboardNow(tickNow);
      setMobilitySnapshot((currentSnapshot) => currentSnapshot ? { ...currentSnapshot, currentTime: tickIso } : currentSnapshot);
      setScenarioClock((currentScenario) => tickNow.getTime() >= addDashboardMinutesR3(currentScenario.meetingStart, 15).getTime()
        ? { anchor: tickNow, meetingStart: addDashboardMinutesR3(tickNow, 90) }
        : currentScenario);
    }, 30_000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    let isCurrent = true;
    const requestCurrentTime = new Date().toISOString();
    const requestMeetingStartTime = scenarioClock.meetingStart.toISOString();
    const mobilityRequest: MobilityDashboardRequestR3 = {
      ...initialMobilityDashboardRequestR3,
      trafficProfile: mobilityProfile,
      currentTime: requestCurrentTime,
      departureTime: requestCurrentTime,
      meetingStartTime: requestMeetingStartTime,
    };
    setMobilitySourceStatus('loading');
    mobilityProvider.getDashboardSnapshot(mobilityRequest).then((snapshot) => {
      if (!isCurrent) return;
      setMobilitySnapshot({
        ...snapshot,
        currentTime: requestCurrentTime,
        meeting: { ...snapshot.meeting, startTime: requestMeetingStartTime },
      });
      setMobilitySourceStatus(snapshot.metadata.isStale ? 'stale' : snapshot.metadata.sourceStatus);
    }).catch((error: unknown) => {
      if (isCurrent) setMobilitySourceStatus(error instanceof MobilityProviderNotConfiguredErrorR3 ? 'provider_not_configured' : 'error');
    });
    return () => { isCurrent = false; };
  }, [mobilityProfile, mobilityProvider, scenarioClock]);

  return (
    <ExecutiveShellR3 {...props} activeSection="dashboard" now={dashboardNow} mainAriaLabel="Estructura del dashboard ejecutivo" rail={<LiaExecutiveRailR3 onAgenda={props.onAgenda} onDocuments={props.onDocuments} priorityView={priorityView} decisionsPending={decisionsPending} criticalRisks={criticalRisks} />}>
        <DashboardMetricsR3 metrics={priorityView.metrics} />
        <div className="lia-dash-r3-map-frame">
          <MobilityMapR3
            profile={mobilityProfile}
            presentation={mobilityPresentation}
            sourceStatus={mobilitySourceStatus}
            onProfileChange={setMobilityProfile}
          />
        </div>
        <DashboardMobilityLowerR3 presentation={mobilityPresentation} sourceStatus={mobilitySourceStatus} priorityView={priorityView} />
    </ExecutiveShellR3>
  );
}
