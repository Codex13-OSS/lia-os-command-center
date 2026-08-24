import { useEffect, useState } from 'react';
import '../../styles/dashboardExecutiveR3.css';
import { ExecutiveShellR3 } from '../executive-r3/ExecutiveShellR3';
import type { LiaConversationController } from '../lia-r3/liaConversationController';
import { DashboardCommandCenterR3, DashboardEvidenceRailR3 } from './DashboardCommandCenterR3';

type DashboardShellR3Props = {
  onDashboard: () => void;
  onAgenda: () => void;
  onProjects: () => void;
  onAgents: () => void; onServers: () => void;
  onSettings: () => void;
  onTracking: () => void;
  onDocuments: () => void;
  onAlerts: () => void;
  onLogout: () => void;
  conversationController?: LiaConversationController;
  operatorName?: string;
};

export function DashboardShellR3(props: DashboardShellR3Props) {
  const [dashboardNow, setDashboardNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setDashboardNow(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <ExecutiveShellR3 {...props} activeSection="dashboard" now={dashboardNow} mainAriaLabel="Cabina principal ejecutiva de LÍA" mainClassName="lia-command-r3-shell" rail={<DashboardEvidenceRailR3 onProjects={props.onProjects} onAgents={props.onAgents} onAgenda={props.onAgenda} conversationController={props.conversationController} />}>
      <DashboardCommandCenterR3 onProjects={props.onProjects} onAgents={props.onAgents} onAgenda={props.onAgenda} conversationController={props.conversationController} />
    </ExecutiveShellR3>
  );
}
