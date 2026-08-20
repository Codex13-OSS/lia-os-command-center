import type { LiaAutonomyGoal, LiaAutonomyHud } from '../../integrations/liaAutonomyHudClient';
import type { LiaOfficeReadModel, LiaOfficeState } from '../../integrations/liaOfficeClient';

export type LiaCoreVisualState =
  | 'offline'
  | 'idle'
  | 'planning'
  | 'delegating'
  | 'executing'
  | 'verifying'
  | 'correcting'
  | 'waiting_human'
  | 'completed'
  | 'failed'
  | 'responding'
  | 'listening'
  | 'speaking';

export type LiaHermesAvailability = 'available' | 'unavailable' | 'unknown';

export type LiaCoreEvidence = {
  office: LiaOfficeReadModel | null;
  hud: LiaAutonomyHud | null;
  hermesAvailability: LiaHermesAvailability;
  chatPending: boolean;
  voiceListening?: boolean;
  voiceSpeaking?: boolean;
  completionTransition?: boolean;
};

export type LiaCoreModel = {
  state: LiaCoreVisualState;
  label: string;
  context: string | null;
  goalTitle: string | null;
  hermesAvailability: LiaHermesAvailability;
  ariaLabel: string;
};

const OFFICE_STATE_MAP: Record<LiaOfficeState, Exclude<LiaCoreVisualState, 'offline' | 'responding' | 'listening' | 'speaking' | 'completed'>> = {
  idle: 'idle',
  queued: 'planning',
  planned: 'planning',
  planning: 'planning',
  delegating: 'delegating',
  implementing: 'executing',
  verifying: 'verifying',
  reviewing: 'verifying',
  correcting: 'correcting',
  waiting_human: 'waiting_human',
  completed: 'idle',
  failed: 'failed',
};

const TASK_STAGE_MAP: Record<string, LiaCoreVisualState> = {
  planning: 'planning',
  hermes: 'delegating',
  codex: 'executing',
  verification: 'verifying',
  commit: 'executing',
  completed: 'idle',
  failed: 'failed',
};

const STATE_LABELS: Record<LiaCoreVisualState, string> = {
  offline: 'Hermes no disponible',
  idle: 'Disponible',
  planning: 'Planificando',
  delegating: 'Coordinando ejecución',
  executing: 'Ejecutando',
  verifying: 'Verificando resultado',
  correcting: 'Corrigiendo después de verificación',
  waiting_human: 'Esperando tu autorización',
  completed: 'Objetivo completado',
  failed: 'Ejecución detenida',
  responding: 'Respondiendo en el chat',
  listening: 'Escuchando',
  speaking: 'Hablando',
};

function priorityGoal(goals: LiaAutonomyGoal[]): LiaAutonomyGoal | null {
  return [...goals].sort((left, right) => {
    const rank = (goal: LiaAutonomyGoal) => goal.humanInterventionRequired ? 4 : goal.status === 'active' ? 3 : goal.status === 'blocked' ? 2 : 1;
    return rank(right) - rank(left) || right.updatedAt - left.updatedAt;
  })[0] ?? null;
}

function activityState(evidence: LiaCoreEvidence, goal: LiaAutonomyGoal | null): LiaCoreVisualState {
  const focus = evidence.office?.focus;
  if (evidence.hud?.supervisor.failClosed || evidence.office?.supervisor.failClosed || focus?.officeState === 'failed' || goal?.hudState === 'failed' || goal?.hudState === 'fail_closed' || goal?.status === 'failed' || goal?.status === 'exhausted') return 'failed';
  if (evidence.hermesAvailability === 'unavailable') return 'offline';
  if (focus?.humanInterventionRequired || focus?.officeState === 'waiting_human' || goal?.humanInterventionRequired || goal?.hudState === 'waiting_human') return 'waiting_human';
  if (evidence.voiceListening === true) return 'listening';
  if (evidence.voiceSpeaking === true) return 'speaking';
  if (evidence.chatPending) return 'responding';
  if (focus?.officeState === 'correcting') return 'correcting';
  if (focus?.officeState === 'verifying' || focus?.officeState === 'reviewing') return 'verifying';
  if (focus?.officeState === 'implementing') return 'executing';
  if (focus?.officeState === 'delegating') return 'delegating';
  if (focus?.officeState) return OFFICE_STATE_MAP[focus.officeState];
  const taskStage = focus?.currentTask?.status ?? goal?.currentTask?.status ?? goal?.loopStage;
  if (taskStage && TASK_STAGE_MAP[taskStage]) return TASK_STAGE_MAP[taskStage];
  if (goal?.hudState === 'executing' || (evidence.hud?.inFlight ?? 0) > 0) return 'executing';
  const supervisorState = evidence.office?.supervisor.state ?? evidence.hud?.supervisor.state;
  return supervisorState ? TASK_STAGE_MAP[supervisorState] ?? 'idle' : 'idle';
}

function realContext(state: LiaCoreVisualState, office: LiaOfficeReadModel | null, goal: LiaAutonomyGoal | null): string | null {
  if (state === 'offline') return 'Hermes no disponible';
  const title = office?.focus?.title ?? goal?.title;
  if (!title) return null;
  const attempt = office?.focus?.currentTask?.attemptNumber ?? goal?.currentTask?.attemptNumber ?? (goal?.currentAttempt !== null && goal?.currentAttempt !== undefined ? goal.currentAttempt + 1 : undefined);
  return attempt !== undefined && ['executing', 'correcting', 'verifying'].includes(state)
    ? `${title} · intento ${attempt}`
    : title;
}

/**
 * Deterministic precedence (highest first): failed/fail-closed, Hermes offline,
 * waiting_human, real browser listening, real browser speaking, real chat
 * responding, correcting, verifying, executing,
 * delegating, planning, evidence-triggered completed confirmation, idle.
 * A historical terminal Goal never outranks a current active/human Goal.
 */
export function deriveLiaCoreModel(evidence: LiaCoreEvidence): LiaCoreModel {
  const goal = priorityGoal(evidence.hud?.goals ?? []);
  let state = activityState(evidence, goal);
  if (state === 'idle' && evidence.completionTransition === true) state = 'completed';
  const context = realContext(state, evidence.office, goal);
  const label = STATE_LABELS[state];
  return {
    state,
    label,
    context,
    goalTitle: evidence.office?.focus?.title ?? goal?.title ?? null,
    hermesAvailability: evidence.hermesAvailability,
    ariaLabel: `LÍA: ${label}${context && context !== label ? `. ${context}` : ''}`,
  };
}

export function hasCompletedEvidence(office: LiaOfficeReadModel | null, hud: LiaAutonomyHud | null): boolean {
  const goal = priorityGoal(hud?.goals ?? []);
  return office?.focus?.officeState === 'completed' || goal?.status === 'completed' || goal?.hudState === 'completed';
}
