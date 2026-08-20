import type { AutonomousV1Capability } from './autonomousAuthority.js';

export const EXECUTIVE_BOARD_ROLES = ['CEO', 'CFO', 'CTO', 'CMO', 'COO', 'LEGAL', 'DATA'] as const;
export type ExecutiveBoardRole = (typeof EXECUTIVE_BOARD_ROLES)[number];

export type ExecutiveBoardDecisionLevel = 'normal' | 'relevant' | 'critical';
export type ExecutiveBoardMode = 'focused' | 'board';
export type ExecutiveBoardPerspectiveStatus = 'completed' | 'blocked_missing_data' | 'failed';

export type ExecutiveBoardEvidence = {
  evidenceId: string;
  kind: 'goal' | 'task' | 'verification' | 'document' | 'metric' | 'specialist_output';
  reference: string;
  summary: string;
};

export type ExecutiveBoardPerspective = {
  role: ExecutiveBoardRole;
  status: ExecutiveBoardPerspectiveStatus;
  position: string;
  rationale: string[];
  risks: string[];
  assumptions: string[];
  missingData: string[];
  proposedActions: string[];
  evidence: ExecutiveBoardEvidence[];
  confidence: number;
};

export type ExecutiveBoardDisagreement = {
  disagreementId: string;
  roles: ExecutiveBoardRole[];
  issue: string;
  positions: Array<{ role: ExecutiveBoardRole; position: string }>;
  resolution: 'unresolved' | 'human_decision_required' | 'resolved';
  resolutionNote?: string;
};

export type ExecutiveBoardOutcome = {
  status: 'pending' | 'approved' | 'rejected' | 'executed' | 'superseded';
  summary?: string;
  recordedAt?: number;
  evidence: ExecutiveBoardEvidence[];
};

export type ExecutiveBoardTerminalOutcomeStatus = Exclude<ExecutiveBoardOutcome['status'], 'pending'>;

export type ExecutiveBoardOutcomeTransition = {
  requestKey: string;
  decisionId: string;
  status: ExecutiveBoardTerminalOutcomeStatus;
  summary?: string;
  recordedAt: number;
  evidence: ExecutiveBoardEvidence[];
};

export type ExecutiveBoardDecision = {
  decisionId: string;
  /** Durable identity of the Board invocation; distinct invocations need distinct keys. */
  requestKey: string;
  version: 'executive-board-v1';
  projectId: string;
  goalId?: string;
  objective: string;
  context: string[];
  level: ExecutiveBoardDecisionLevel;
  mode: ExecutiveBoardMode;
  rolesConsulted: ExecutiveBoardRole[];
  routingReasons: Array<{ role: ExecutiveBoardRole; reason: string }>;
  perspectives: ExecutiveBoardPerspective[];
  disagreements: ExecutiveBoardDisagreement[];
  risks: string[];
  assumptions: string[];
  missingData: string[];
  recommendation: string;
  confidence: number;
  proposedActions: string[];
  requiresHumanApproval: boolean;
  evidence: ExecutiveBoardEvidence[];
  outcome: ExecutiveBoardOutcome;
  /** Advisory boundary snapshot only. Board consultation never grants capabilities. */
  authoritySnapshot: {
    requested: AutonomousV1Capability[];
    grantedByBoard: [];
  };
  createdAt: number;
  updatedAt: number;
};

export type ExecutiveBoardDecisionRequest = {
  requestKey: string;
  projectId: string;
  goalId?: string;
  objective: string;
  context?: string[];
  level: ExecutiveBoardDecisionLevel;
  riskSignals?: string[];
  requestedCapabilities?: AutonomousV1Capability[];
  evidence?: ExecutiveBoardEvidence[];
};

export interface ExecutiveBoardDecisionStore {
  recordDecision(input: {
    requestKey: string;
    requestHash: string;
    decision: ExecutiveBoardDecision;
  }): ExecutiveBoardDecision;
  readDecision(decisionId: string): ExecutiveBoardDecision | undefined;
  listDecisions(input: { projectId: string; goalId?: string; limit?: number }): ExecutiveBoardDecision[];
  transitionOutcome(transition: ExecutiveBoardOutcomeTransition): ExecutiveBoardDecision;
}

export interface ExecutiveBoardSpecialistAdapter {
  consult(input: {
    role: ExecutiveBoardRole;
    request: ExecutiveBoardDecisionRequest;
    routingReason: string;
  }): Promise<ExecutiveBoardPerspective>;
  /**
   * Preferred Board path. Implementations must consult exactly these already
   * routed roles in one bounded specialist execution; they must not re-route.
   */
  consultBoard?(input: {
    roles: ExecutiveBoardRole[];
    request: ExecutiveBoardDecisionRequest;
    routingReasons: Array<{ role: ExecutiveBoardRole; reason: string }>;
  }): Promise<ExecutiveBoardPerspective[]>;
}
