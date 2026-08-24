import { useMemo } from 'react';
import { isExecutiveGoal, type LiaAutonomyGoal, type LiaAutonomyHud } from '../../integrations/liaAutonomyHudClient';
import { useLiaCoreState } from '../lia-core-r3/useLiaCoreState';

const HUD_LABELS: Record<LiaAutonomyGoal['hudState'], string> = {
  completed: 'Completado',
  executing: 'Ejecutando',
  waiting_human: 'Atención humana',
  suspended: 'Suspendido',
  failed: 'Fallido',
  fail_closed: 'Protegido',
};

const SUPERVISOR_LABELS: Record<string, string> = {
  unsupported: 'No soportado',
  idle: 'En espera',
  pending: 'Trabajo pendiente',
  running: 'Supervisando',
  fail_closed: 'Protección activa',
};

function useAutonomyHud(): LiaAutonomyHud | null {
  return useLiaCoreState().hud;
}

function formatPassTime(at: number | undefined): string {
  if (at === undefined || !Number.isFinite(at)) return 'Sin pase registrado';
  try {
    return new Intl.DateTimeFormat('es-MX', {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(at));
  } catch {
    return 'Fecha no disponible';
  }
}

function supervisorLabel(hud: LiaAutonomyHud | null): string {
  if (!hud) return 'Conectando';
  return SUPERVISOR_LABELS[hud.supervisor.state] ?? hud.supervisor.state;
}

function goalClass(goal: LiaAutonomyGoal): string {
  if (goal.hudState === 'failed' || goal.hudState === 'fail_closed') return 'is-failed';
  if (goal.humanInterventionRequired || goal.hudState === 'waiting_human' || goal.hudState === 'suspended') return 'is-blocked';
  if (goal.hudState === 'completed') return 'is-completed';
  return 'is-operational';
}

export function ProjectsAutonomyHudR3() {
  const hud = useAutonomyHud();
  const distribution = useMemo(() => {
    const goals = hud?.goals ?? [];
    return {
      operational: goals.filter((goal) => goal.status === 'active' && goalClass(goal) === 'is-operational').length,
      blocked: goals.filter((goal) => goal.status === 'active' && goalClass(goal) === 'is-blocked').length,
      failed: goals.filter((goal) => goalClass(goal) === 'is-failed').length,
    };
  }, [hud]);
  const recentGoals = useMemo(
    () => [...(hud?.goals ?? [])].filter(isExecutiveGoal).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 4),
    [hud],
  );
  const capacity = hud?.supervisor.goals;
  const usedSlots = capacity?.inFlight ?? hud?.inFlight;
  const slotCeiling = capacity?.externalExecutionCeiling ?? hud?.externalExecutionCeiling;
  const capacityPercent = usedSlots !== undefined && slotCeiling
    ? Math.min(100, Math.round((usedSlots / slotCeiling) * 100))
    : 0;

  return (
    <section className="lia-autonomy-hud-r3" aria-label="LÍA Autonomy HUD">
      <header className="lia-autonomy-hud-r3-head">
        <div>
          <span><i aria-hidden="true" /> LÍA EXECUTIVE AUTONOMY</span>
          <strong>Control de objetivos</strong>
        </div>
        <b className={`is-${hud?.supervisor.state ?? 'loading'}`}>{supervisorLabel(hud)}</b>
      </header>

      <div className="lia-autonomy-hud-r3-layout">
        <div className="lia-autonomy-hud-r3-overview">
          <article className="lia-autonomy-hud-r3-primary">
            <span>Objetivos activos</span>
            <strong>{hud?.activeCount ?? capacity?.activeGoalCount ?? '—'}</strong>
            <small>{hud ? `${hud.totalGoals} registrados · ${hud.terminalCount} terminales` : 'Leyendo Goals'}</small>
          </article>
          <article>
            <span>Ejecutando</span>
            <strong>{hud?.executingCount ?? capacity?.executingGoalCount ?? '—'}</strong>
            <small>Estado durable actual</small>
          </article>
          <article className={(hud?.humanInterventionRequiredCount ?? 0) > 0 ? 'is-attention' : undefined}>
            <span>Atención humana</span>
            <strong>{hud?.humanInterventionRequiredCount ?? capacity?.humanInterventionRequiredCount ?? '—'}</strong>
            <small>{capacity ? `${capacity.blockedOnHumanGoalCount} bloqueados` : 'Leyendo límites'}</small>
          </article>
          <article className="lia-autonomy-hud-r3-capacity">
            <span>Slots de ejecución</span>
            <strong>{usedSlots ?? '—'}<em> / {slotCeiling ?? '—'}</em></strong>
            <div className="lia-autonomy-hud-r3-meter" aria-label={hud ? `${usedSlots} de ${slotCeiling} slots ocupados` : 'Capacidad sin datos'}>
              <i style={{ width: `${capacityPercent}%` }} />
            </div>
          </article>
        </div>

        <div className="lia-autonomy-hud-r3-distribution" aria-label="Distribución real de objetivos">
          <span>Distribución</span>
          <div><i className="is-operational" /><strong>{hud ? distribution.operational : '—'}</strong><small>Operativos</small></div>
          <div><i className="is-blocked" /><strong>{hud ? distribution.blocked : '—'}</strong><small>Bloqueados</small></div>
          <div><i className="is-failed" /><strong>{hud ? distribution.failed : '—'}</strong><small>Fallidos</small></div>
        </div>

        <div className="lia-autonomy-hud-r3-recent">
          <header><span>OBJETIVOS RECIENTES</span><small>actualización durable</small></header>
          {recentGoals.length > 0 ? recentGoals.map((goal) => (
            <article key={goal.goalId} className={goalClass(goal)}>
              <i aria-hidden="true" />
              <div>
                <strong title={goal.title}>{goal.title}</strong>
                <small>{HUD_LABELS[goal.hudState]} · Intento {goal.currentAttempt === null ? '—' : goal.currentAttempt + 1}/{goal.maxAttempts}</small>
              </div>
              <time dateTime={new Date(goal.updatedAt).toISOString()}>{formatPassTime(goal.updatedAt)}</time>
            </article>
          )) : (
            <p>{hud ? 'No hay objetivos registrados.' : 'Leyendo objetivos reales…'}</p>
          )}
        </div>
      </div>

      <footer className="lia-autonomy-hud-r3-foot">
        <span>Supervisor · {hud?.supervisor.lastPass?.source ?? 'sin origen'}</span>
        <time dateTime={hud?.supervisor.lastPass?.at ? new Date(hud.supervisor.lastPass.at).toISOString() : undefined}>
          {formatPassTime(hud?.supervisor.lastPass?.at)}
        </time>
        <span>{hud?.supervisor.passInProgress ? 'Pase en curso' : hud?.supervisor.pendingWakeup ? 'Siguiente pase pendiente' : 'Sin pase pendiente'}</span>
      </footer>
    </section>
  );
}

export function DashboardAutonomySummaryR3() {
  const hud = useAutonomyHud();
  const goals = hud?.supervisor.goals;
  const inFlight = goals?.inFlight ?? hud?.inFlight;
  const ceiling = goals?.externalExecutionCeiling ?? hud?.externalExecutionCeiling;

  return (
    <section className="lia-dash-autonomy-r3" aria-label="Resumen ejecutivo de autonomía">
      <header>
        <div><span><i aria-hidden="true" /> AUTONOMÍA REAL</span><strong>{supervisorLabel(hud)}</strong></div>
        <small>{formatPassTime(hud?.supervisor.lastPass?.at)}</small>
      </header>
      <div className="lia-dash-autonomy-r3-metrics">
        <article><span>Activos</span><strong>{hud?.activeCount ?? goals?.activeGoalCount ?? '—'}</strong></article>
        <article><span>Ejecutando</span><strong>{hud?.executingCount ?? goals?.executingGoalCount ?? '—'}</strong></article>
        <article className={(hud?.humanInterventionRequiredCount ?? 0) > 0 ? 'is-attention' : undefined}><span>Bloqueos humanos</span><strong>{hud?.humanInterventionRequiredCount ?? goals?.humanInterventionRequiredCount ?? '—'}</strong></article>
        <article><span>Capacidad</span><strong>{inFlight ?? '—'}<em> / {ceiling ?? '—'}</em></strong></article>
      </div>
      <footer>
        <span>Supervisor: {hud?.supervisor.lastPass?.source ?? 'sin pase'}</span>
        <span>{hud?.supervisor.passInProgress ? 'Pase en curso' : hud?.supervisor.pendingWakeup ? 'Pase pendiente' : 'Sin trabajo pendiente'}</span>
      </footer>
    </section>
  );
}
