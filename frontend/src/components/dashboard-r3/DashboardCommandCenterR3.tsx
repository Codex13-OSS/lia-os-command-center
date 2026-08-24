import { useEffect, useMemo, useState } from 'react';
import { isExecutivePriorityGoal, type LiaAutonomyGoal } from '../../integrations/liaAutonomyHudClient';
import { type LiaOfficeState } from '../../integrations/liaOfficeClient';
import { readLatestExecutiveBoardDecision, type LiaExecutiveBoardDecision } from '../../integrations/liaExecutiveBoardClient';
import { LiaCoreR3 } from '../lia-core-r3/LiaCoreR3';
import { useLiaCoreState } from '../lia-core-r3/useLiaCoreState';
import type { LiaConversationController } from '../lia-r3/liaConversationController';
import { LiaVoiceSurfaceR3 } from '../lia-r3/LiaVoiceSurfaceR3';
import { LiaLocationWeatherR3 } from './LiaLocationWeatherR3';

const ACTIVE_OFFICE_STATES = new Set<LiaOfficeState>(['queued', 'planning', 'delegating', 'implementing', 'verifying', 'reviewing', 'correcting', 'waiting_human']);

const STAGE_LABELS: Record<string, string> = {
  awaiting_execution: 'Esperando ejecución', executing: 'Ejecutando', awaiting_evaluation: 'Esperando evaluación',
  awaiting_continuation_plan: 'Preparando continuación', awaiting_continuation_approval: 'Esperando aprobación',
  continuation_approved: 'Continuación aprobada', next_attempt_accepted: 'Siguiente intento aceptado',
  completed: 'Completado', exhausted: 'Intentos agotados', failed_closed: 'Protección activa', suspended: 'Suspendido',
};
const OFFICE_LABELS: Record<LiaOfficeState, string> = {
  idle: 'En espera', queued: 'En cola', planned: 'Planificado', planning: 'Planificando', delegating: 'Delegando',
  implementing: 'Implementando', verifying: 'Verificando', reviewing: 'Revisando', correcting: 'Corrigiendo',
  waiting_human: 'Espera humana', completed: 'Completado', failed: 'Fallido',
};

type Props = { onProjects: () => void; onAgents: () => void; onAgenda: () => void; conversationController?: LiaConversationController };
type Attention = { id: string; title: string; detail: string; tone: 'attention' | 'critical' };

function formatDate(value?: number): string {
  if (value === undefined || !Number.isFinite(value)) return 'Sin fecha durable';
  try { return new Intl.DateTimeFormat('es-MX', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(value)); }
  catch { return 'Fecha no disponible'; }
}
function stageLabel(stage: string): string { return STAGE_LABELS[stage] ?? stage.replace(/_/g, ' '); }
function attemptLabel(goal: LiaAutonomyGoal): string {
  return goal.currentTask?.attemptNumber !== undefined
    ? `${goal.currentTask.attemptNumber}/${goal.maxAttempts}`
    : goal.currentAttempt !== null ? `${goal.currentAttempt + 1}/${goal.maxAttempts}` : `—/${goal.maxAttempts}`;
}
function reasonLabel(reason?: string): string {
  if (!reason) return 'La evidencia no incluye una razón segura.';
  return reason.replace(/_/g, ' ');
}

export function DashboardCommandCenterR3({ onProjects, onAgents, onAgenda, conversationController }: Props) {
  const { hud, office, loaded, core } = useLiaCoreState();
  const state = { hud, office, loaded };
  const [board, setBoard] = useState<{ loading: boolean; durable: boolean; decision: LiaExecutiveBoardDecision | null }>({ loading: false, durable: false, decision: null });

  const priorityGoal = useMemo(() => {
    const goals = (state.hud?.goals ?? []).filter(isExecutivePriorityGoal);
    return [...goals].sort((a, b) => {
      const rank = (goal: LiaAutonomyGoal) => goal.humanInterventionRequired ? 3 : goal.status === 'active' ? 2 : 1;
      return rank(b) - rank(a) || b.updatedAt - a.updatedAt;
    })[0];
  }, [state.hud]);

  useEffect(() => {
    if (!priorityGoal?.projectId) { setBoard({ loading: false, durable: false, decision: null }); return; }
    let cancelled = false;
    setBoard((current) => ({ ...current, loading: true }));
    void readLatestExecutiveBoardDecision(priorityGoal.projectId).then((result) => {
      if (!cancelled) setBoard({ loading: false, ...result });
    });
    return () => { cancelled = true; };
  }, [priorityGoal?.projectId]);

  const capacity = state.hud?.supervisor.goals;
  const active = state.hud?.activeCount ?? capacity?.activeGoalCount;
  const executing = state.hud?.executingCount ?? capacity?.executingGoalCount;
  const waitingHuman = state.hud?.humanInterventionRequiredCount ?? capacity?.humanInterventionRequiredCount;
  const inFlight = capacity?.inFlight ?? state.hud?.inFlight ?? state.office?.capacity.inFlight;
  const ceiling = capacity?.externalExecutionCeiling ?? state.hud?.externalExecutionCeiling ?? state.office?.capacity.ceiling;
  const activeAgents = (state.office?.agents ?? []).filter((agent) => ACTIVE_OFFICE_STATES.has(agent.state) && agent.evidenceKind !== 'none');
  const failedGoals = state.hud?.supervisor.goals?.failedOrSuspendedGoalCount
    ?? state.hud?.goals.filter((goal) => goal.status === 'failed' || goal.status === 'exhausted' || goal.hudState === 'fail_closed').length;
  const telemetryUpdatedAt = state.office?.generatedAt ?? state.hud?.supervisor.lastPass?.at;

  const attention = useMemo<Attention[]>(() => {
    const entries: Attention[] = [];
    for (const goal of state.hud?.goals ?? []) {
      if (goal.humanInterventionRequired || goal.hudState === 'waiting_human') entries.push({ id: `${goal.goalId}-human`, title: goal.title, detail: reasonLabel(goal.blockingReason), tone: 'attention' });
      else if (goal.status === 'failed' || goal.status === 'exhausted' || goal.hudState === 'failed' || goal.hudState === 'fail_closed') entries.push({ id: `${goal.goalId}-failed`, title: goal.title, detail: `${stageLabel(goal.loopStage)} · ${reasonLabel(goal.blockingReason)}`, tone: 'critical' });
      if (goal.noProgress?.escalated) entries.push({ id: `${goal.goalId}-progress`, title: 'Sin progreso confirmado', detail: `${goal.title} · ${goal.noProgress.count}/${goal.noProgress.threshold} evaluaciones`, tone: 'critical' });
      if (/expired|revoked/.test(`${goal.suspensionState ?? ''} ${goal.blockingReason ?? ''}`)) entries.push({ id: `${goal.goalId}-policy`, title: 'Autorización o política no vigente', detail: `${goal.title} · ${reasonLabel(goal.blockingReason ?? goal.suspensionState)}`, tone: 'attention' });
    }
    if (state.office?.focus?.retry && state.office.focus.officeState !== 'completed') entries.push({ id: 'focus-retry', title: 'Reintento en curso', detail: `${state.office.focus.title} · intento ${state.office.focus.currentTask?.attemptNumber ?? 'registrado'}`, tone: 'attention' });
    if (board.decision?.requiresHumanApproval && board.decision.outcome.status === 'pending') entries.push({ id: `board-${board.decision.decisionId}`, title: 'Board requiere aprobación humana', detail: board.decision.recommendation, tone: 'attention' });
    return entries;
  }, [board.decision, state.hud, state.office]);


  const hasConnection = Boolean(state.hud || state.office);
  const failClosed = state.hud?.supervisor.failClosed || state.office?.supervisor.failClosed;
  const generalTone = !state.loaded ? 'loading' : !hasConnection ? 'unavailable' : failClosed || attention.some((item) => item.tone === 'critical') ? 'critical' : attention.length ? 'attention' : (executing ?? 0) > 0 ? 'active' : 'stable';
  const generalLabel = !state.loaded ? 'Conectando evidencia' : !hasConnection ? 'Datos operativos no disponibles' : failClosed ? 'Protección fail-closed activa' : attention.some((item) => item.tone === 'critical') ? 'Incidencias requieren revisión' : attention.length ? 'Atención ejecutiva requerida' : (executing ?? 0) > 0 ? 'LÍA está ejecutando' : 'Operación estable, sin ejecución activa';
  const supervisorState = state.hud?.supervisor.state ?? state.office?.supervisor.state;
  const supervisorLabel = supervisorState === 'idle' ? 'En espera' : supervisorState ?? (state.loaded ? 'No disponible' : 'Conectando');
  const heroCore = core.state === 'idle' ? { ...core, label: 'En espera' } : core;

  return <>
    <header className={`lia-command-r3-hero is-${generalTone}`}>
      <div className="lia-command-r3-hero-copy"><h1>Centro de mando LÍA</h1><p>{generalLabel}</p></div>
      <div className="lia-command-r3-core-cluster"><LiaCoreR3 model={heroCore} /></div>
      <div className="lia-command-r3-hero-actions"><div className="lia-command-r3-system"><i aria-hidden="true" /><div><small>SUPERVISOR</small><strong>{supervisorLabel}</strong></div></div><LiaVoiceSurfaceR3 controller={conversationController} compact /></div>
    </header>

    <section className="lia-command-r3-grid" aria-label="Resumen operativo ejecutivo">
      <article className="lia-command-r3-card lia-command-r3-goal">
        <header><span>OBJETIVO EJECUTIVO ACTUAL</span><button type="button" onClick={onProjects}>Abrir Proyectos →</button></header>
        {!state.loaded ? <p className="lia-command-r3-empty">Leyendo Goals durables…</p> : priorityGoal ? <>
          <div className="lia-command-r3-goal-state"><b className={`is-${priorityGoal.hudState}`}>{priorityGoal.humanInterventionRequired ? 'Atención humana' : stageLabel(priorityGoal.loopStage)}</b><small>Proyecto · {priorityGoal.projectId}</small></div>
          <h2>{priorityGoal.title}</h2>
          <dl><div><dt>Etapa</dt><dd>{stageLabel(priorityGoal.loopStage)}</dd></div><div><dt>Intento</dt><dd>{attemptLabel(priorityGoal)}</dd></div><div><dt>Profundidad</dt><dd>{priorityGoal.continuationDepth}/{priorityGoal.maxDepth}</dd></div><div><dt>Task actual</dt><dd>{priorityGoal.currentTask?.taskId ?? state.office?.focus?.currentTask?.taskId ?? 'Sin task actual'}</dd></div></dl>
          {priorityGoal.latestEvidence && <footer><span>EVIDENCIA</span><strong>{priorityGoal.latestEvidence.decision} · {priorityGoal.latestEvidence.reasonCode}</strong><small>{priorityGoal.latestEvidence.summary}</small></footer>}
        </> : <p className="lia-command-r3-empty">No hay un objetivo ejecutivo activo. La evidencia histórica y de validación permanece disponible en Proyectos.</p>}
      </article>

      <article className="lia-command-r3-card lia-command-r3-autonomy">
        <header><span>AUTONOMÍA / SUPERVISOR</span><small>{!state.loaded ? 'Conectando evidencia' : !state.hud ? 'Supervisor no disponible' : state.hud.supervisor.passInProgress ? 'Pase en curso' : state.hud.supervisor.pendingWakeup ? 'Pase pendiente' : 'Sin pase pendiente'}</small></header>
        <div className="lia-command-r3-autonomy-metrics"><div><span>Activos</span><strong>{active ?? '—'}</strong></div><div><span>Ejecutando</span><strong>{executing ?? '—'}</strong></div><div className={(waitingHuman ?? 0) > 0 ? 'is-attention' : ''}><span>Esperando humano</span><strong>{waitingHuman ?? '—'}</strong></div><div><span>Capacidad</span><strong>{inFlight ?? '—'}<em> / {ceiling ?? '—'}</em></strong></div></div>
        <div className="lia-command-r3-slots" aria-label={inFlight !== undefined && ceiling !== undefined ? `${inFlight} de ${ceiling} slots ocupados` : 'Capacidad no disponible'}>{ceiling !== undefined && ceiling > 0 ? Array.from({ length: ceiling }, (_, index) => <i key={index} className={index < (inFlight ?? 0) ? 'is-used' : ''} />) : <span>Sin lectura de slots</span>}</div>
      </article>

      <article className="lia-command-r3-card lia-command-r3-office">
        <header><span>OFICINA / ACTIVIDAD CONFIRMADA</span><button type="button" onClick={onAgents}>Entrar a Oficina →</button></header>
        {!state.loaded ? <p className="lia-command-r3-empty">Leyendo Office read model…</p> : !state.office ? <p className="lia-command-r3-empty">La Oficina no está disponible. No se infieren agentes activos.</p> : <>
          <div className="lia-command-r3-office-summary"><strong>{activeAgents.length}</strong><span>{activeAgents.length === 1 ? 'agente con actividad respaldada' : 'agentes con actividad respaldada'}</span><small>{state.office.capacity.inFlight} / {state.office.capacity.ceiling} slots en uso</small></div>
          <div className="lia-command-r3-agent-list">{activeAgents.length ? activeAgents.map((agent) => <div key={agent.id}><i className={`is-${agent.state}`} aria-hidden="true" /><span><strong>{agent.name}</strong><small>{agent.role}</small></span><b>{OFFICE_LABELS[agent.state]}</b></div>) : <p className="lia-command-r3-empty">Ningún agente aparece activo en la evidencia durable actual.</p>}</div>
        </>}
      </article>

      <article className="lia-command-r3-card lia-command-r3-board">
        <header><span>EXECUTIVE BOARD / ÚLTIMA DECISIÓN</span><button type="button" onClick={onProjects}>Board / Executive →</button></header>
        {board.loading ? <p className="lia-command-r3-empty">Consultando registro durable…</p> : board.decision ? <>
          <div className="lia-command-r3-board-meta"><b className={`is-${board.decision.level}`}>{board.decision.level}</b><span>{board.decision.mode === 'board' ? 'Board completo' : 'Consulta focalizada'}</span><time dateTime={new Date(board.decision.createdAt).toISOString()}>{formatDate(board.decision.createdAt)}</time></div>
          <h2>{board.decision.recommendation}</h2><p>{board.decision.objective}</p>
          <dl><div><dt>Roles</dt><dd>{board.decision.rolesConsulted.join(' · ')}</dd></div><div><dt>Confidence</dt><dd>{Math.round(board.decision.confidence * 100)}%</dd></div><div><dt>Outcome</dt><dd>{board.decision.outcome.status}</dd></div><div><dt>Aprobación humana</dt><dd>{board.decision.requiresHumanApproval ? 'Requerida' : 'No requerida'}</dd></div></dl>
        </> : <p className="lia-command-r3-empty">{priorityGoal ? (board.durable ? 'No hay decisiones reales registradas para este proyecto.' : 'El registro de Board no está disponible.') : 'Sin Goal prioritario no se consulta una decisión de proyecto.'}</p>}
      </article>
    </section>

    <section className="lia-command-r3-observability" aria-label="Telemetría esencial">
      <header className="lia-command-r3-observability-heading">
        <div><span>TELEMETRÍA ESENCIAL</span><strong>Estado operativo y contexto</strong></div>
        <small>{telemetryUpdatedAt ? `Actualizado · ${formatDate(telemetryUpdatedAt)}` : 'Sin lectura durable'}</small>
      </header>

      <div className="lia-command-r3-observability-metrics">
        <article><span>Hermes</span><strong>{core.hermesAvailability === 'available' ? 'Disponible' : core.hermesAvailability === 'unavailable' ? 'No disponible' : 'Sin lectura'}</strong></article>
        <article><span>Agentes activos</span><strong>{state.loaded ? activeAgents.length : '—'}</strong></article>
        <article><span>Ejecución</span><strong>{inFlight ?? '—'} <em>/ {ceiling ?? '—'}</em></strong></article>
        <article className={(waitingHuman ?? 0) > 0 ? 'is-attention' : ''}><span>Atención humana</span><strong>{waitingHuman ?? '—'}</strong></article>
        <article className={(failedGoals ?? 0) > 0 ? 'is-critical' : ''}><span>Fallos</span><strong>{failedGoals ?? '—'}</strong></article>
      </div>

      <div className="lia-command-r3-context-widgets">
        <LiaLocationWeatherR3 />
      </div>
    </section>

    <nav className="lia-command-r3-access" aria-label="Accesos ejecutivos">
      <button type="button" onClick={onProjects}><span>01</span><strong>Proyectos</strong><small>Goals y ejecución</small></button>
      <button type="button" onClick={onAgents}><span>02</span><strong>Oficina</strong><small>Agentes y estaciones</small></button>
      <button type="button" onClick={onProjects}><span>03</span><strong>Board / Executive</strong><small>Decisiones durables</small></button>
      <button type="button" onClick={onAgenda}><span>04</span><strong>Agenda</strong><small>Calendario ejecutivo</small></button>
    </nav>
  </>;
}

export function DashboardEvidenceRailR3({ onProjects, onAgents, onAgenda }: Props) {
  const { hud, office, loaded, core } = useLiaCoreState();
  const state = { hud, office, loaded };
  const attention = useMemo<Attention[]>(() => {
    const entries: Attention[] = [];
    for (const goal of state.hud?.goals ?? []) {
      if (goal.noProgress?.escalated) entries.push({ id: `${goal.goalId}-no-progress`, title: goal.title, detail: `No-progress ${goal.noProgress.count}/${goal.noProgress.threshold}`, tone: 'critical' });
      else if (goal.status === 'failed' || goal.status === 'exhausted' || goal.hudState === 'fail_closed') entries.push({ id: `${goal.goalId}-failure`, title: goal.title, detail: `${stageLabel(goal.loopStage)} · ${reasonLabel(goal.blockingReason)}`, tone: 'critical' });
      else if (goal.humanInterventionRequired) entries.push({ id: `${goal.goalId}-human`, title: goal.title, detail: reasonLabel(goal.blockingReason), tone: 'attention' });
      if (/expired|revoked/.test(`${goal.suspensionState ?? ''} ${goal.blockingReason ?? ''}`)) entries.push({ id: `${goal.goalId}-policy`, title: 'Política o autorización no vigente', detail: `${goal.title} · ${reasonLabel(goal.blockingReason ?? goal.suspensionState)}`, tone: 'attention' });
    }
    if (state.office?.focus?.retry && state.office.focus.officeState !== 'completed') entries.push({ id: 'office-retry', title: 'Reintento en curso', detail: `${state.office.focus.title} · intento ${state.office.focus.currentTask?.attemptNumber ?? 'registrado'}`, tone: 'attention' });
    for (const decision of state.office?.board.decisions ?? []) if (decision.requiresHumanApproval && decision.outcome === 'pending') entries.push({ id: `board-${decision.decisionId}`, title: 'Board espera aprobación humana', detail: `${decision.level} · ${decision.rolesConsulted.join(', ')}`, tone: 'attention' });
    return entries;
  }, [state.hud, state.office]);
  const activity = useMemo(() => {
    const entries: Array<{ id: string; at: number; title: string; detail: string; state: string }> = (state.hud?.goals ?? []).map((goal) => ({ id: `goal-${goal.goalId}`, at: goal.updatedAt, title: goal.title, detail: `${stageLabel(goal.loopStage)} · intento ${attemptLabel(goal)}`, state: goal.hudState }));
    const task = state.office?.focus?.currentTask;
    if (task) entries.push({ id: `task-${task.taskId}`, at: task.updatedAt, title: `Task ${task.taskId}`, detail: `${task.status} · intento ${task.attemptNumber}`, state: state.office?.focus?.humanInterventionRequired ? 'waiting_human' : 'executing' });
    for (const decision of state.office?.board.decisions ?? []) entries.push({ id: `board-${decision.decisionId}`, at: decision.updatedAt, title: 'Decisión del Executive Board', detail: `${decision.outcome} · ${decision.rolesConsulted.join(', ')}`, state: decision.requiresHumanApproval && decision.outcome === 'pending' ? 'waiting_human' : 'completed' });
    return entries.sort((a, b) => b.at - a.at).slice(0, 8);
  }, [state.hud, state.office]);
  const activeAgents = (office?.agents ?? []).filter((agent) => ACTIVE_OFFICE_STATES.has(agent.state) && agent.evidenceKind !== 'none').length;
  const inFlight = hud?.supervisor.goals?.inFlight ?? hud?.inFlight ?? office?.capacity.inFlight;
  const ceiling = hud?.supervisor.goals?.externalExecutionCeiling ?? hud?.externalExecutionCeiling ?? office?.capacity.ceiling;
  const activeGoals = hud?.supervisor.goals?.activeGoalCount ?? hud?.activeCount;
  const human = hud?.supervisor.goals?.humanInterventionRequiredCount ?? hud?.humanInterventionRequiredCount;
  const failed = hud?.supervisor.goals?.failedOrSuspendedGoalCount ?? hud?.goals.filter((goal) => goal.status === 'failed' || goal.status === 'exhausted' || goal.hudState === 'fail_closed').length;
  const updatedAt = office?.generatedAt ?? hud?.supervisor.lastPass?.at;
  return <aside className="lia-command-r3-rail" aria-label="Atención y actividad durable">
    <section className="lia-command-r3-telemetry"><header><span>TELEMETRÍA</span><small>READ MODELS</small></header><dl><div><dt>Agentes activos</dt><dd>{loaded ? activeAgents : '—'}</dd></div><div><dt>Ejecuciones</dt><dd>{inFlight ?? '—'} / {ceiling ?? '—'}</dd></div><div><dt>Goals activos</dt><dd>{activeGoals ?? '—'}</dd></div><div><dt>Atención humana</dt><dd>{human ?? '—'}</dd></div><div><dt>Failed / fail-closed</dt><dd>{failed ?? '—'}</dd></div><div><dt>Hermes</dt><dd>{core.hermesAvailability === 'available' ? 'disponible' : core.hermesAvailability === 'unavailable' ? 'no disponible' : 'sin lectura'}</dd></div></dl>{updatedAt && <time dateTime={new Date(updatedAt).toISOString()}>Actualizado · {formatDate(updatedAt)}</time>}</section>
    <LiaLocationWeatherR3 />
    <section><header><span>ATTENTION CENTER</span><b>{state.loaded && (state.hud || state.office) ? attention.length : '—'}</b></header>{!state.loaded ? <p>Consultando evidencia…</p> : !state.hud && !state.office ? <p>No disponible. No se muestran alertas inferidas.</p> : attention.length ? <div className="lia-command-r3-attention-list">{attention.map((item) => <article key={item.id} className={`is-${item.tone}`}><i aria-hidden="true" /><div><strong>{item.title}</strong><small>{item.detail}</small><button type="button" onClick={onProjects}>Abrir control humano</button></div></article>)}</div> : <p className="is-clear">Sin bloqueos humanos, failures, retries o no-progress en la evidencia actual.</p>}</section>
    <section className="lia-command-r3-recent"><header><span>ACTIVIDAD RECIENTE</span><small>EVIDENCIA DURABLE</small></header>{!state.loaded ? <p>Consultando actualizaciones…</p> : activity.length ? activity.map((item) => <article key={item.id}><i className={`is-${item.state}`} aria-hidden="true" /><div><strong>{item.title}</strong><small>{item.detail}</small><time dateTime={new Date(item.at).toISOString()}>{formatDate(item.at)}</time></div></article>) : <p>No hay actividad durable disponible.</p>}</section>
    <nav aria-label="Accesos rápidos"><button type="button" onClick={onProjects}>Proyectos</button><button type="button" onClick={onAgents}>Oficina</button><button type="button" onClick={onProjects}>Board</button><button type="button" onClick={onAgenda}>Agenda</button></nav>
  </aside>;
}
