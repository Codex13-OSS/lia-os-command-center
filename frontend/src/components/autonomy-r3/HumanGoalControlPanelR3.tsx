import { useCallback, useEffect, useMemo, useState } from 'react';
import { type LiaAutonomyGoal } from '../../integrations/liaAutonomyHudClient';
import { readLiaGoalControl, runLiaGoalControlAction, type LiaGoalControlAction, type LiaGoalControlSnapshot } from '../../integrations/liaHumanControlClient';
import { ConfirmControlDialogR3 } from './ConfirmControlDialogR3';
import { useLiaCoreState } from '../lia-core-r3/useLiaCoreState';

const DESTRUCTIVE = new Set<LiaGoalControlAction>(['refuse-continuation', 'revoke-approval', 'revoke-authorization']);
const LABELS: Record<LiaGoalControlAction, string> = {
  suspend: 'Suspender', resume: 'Reanudar', 'approve-continuation': 'Aprobar continuación',
  'refuse-continuation': 'Rechazar continuación', 'revoke-approval': 'Revocar aprobación',
  'authorize-execution': 'Autorizar ejecución', 'revoke-authorization': 'Revocar autorización',
};

type Loaded = { goal: LiaAutonomyGoal; control: LiaGoalControlSnapshot };

function validActions({ goal, control }: Loaded): LiaGoalControlAction[] {
  const actions: LiaGoalControlAction[] = [];
  const { autonomy, continuation } = control;
  const activePolicy = !['manual_only', 'suspended', 'revoked', 'expired'].includes(autonomy.policyState);
  if (autonomy.policyState === 'suspended') actions.push('resume');
  else if (goal.status === 'active' && activePolicy) actions.push('suspend');
  if (goal.loopStage === 'authorization_required' && continuation.materializationState === 'pending') {
    if (continuation.approval.state === 'approval_required') actions.push('approve-continuation', 'refuse-continuation');
    if (continuation.approval.state === 'approval_present' && !continuation.approval.revokedAt) actions.push('revoke-approval');
  }
  if (autonomy.mode === 'approved_single_step' && continuation.materializationState === 'materialized'
    && continuation.authorization.state === 'authorization_required') actions.push('authorize-execution');
  if (continuation.authorization.authorizationId && continuation.authorization.state === 'authorization_present'
    && !continuation.authorization.consumedAt && !continuation.authorization.revokedAt) actions.push('revoke-authorization');
  return actions;
}

export function HumanGoalControlPanelR3() {
  const { hud, loaded: hudLoaded, refresh: refreshCore } = useLiaCoreState();
  const [state, setState] = useState<{ loading: boolean; loaded: Loaded | null; unavailable: boolean }>({ loading: true, loaded: null, unavailable: false });
  const [pending, setPending] = useState<LiaGoalControlAction | null>(null);
  const [running, setRunning] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!hud) { setState({ loading: !hudLoaded, loaded: null, unavailable: hudLoaded }); return; }
    const candidates = [...hud.goals].filter((goal) => goal.status === 'active').sort((a, b) => Number(b.humanInterventionRequired) - Number(a.humanInterventionRequired) || b.updatedAt - a.updatedAt);
    for (const goal of candidates) {
      const control = await readLiaGoalControl(goal.goalId);
      if (control && validActions({ goal, control }).length > 0) { setState({ loading: false, loaded: { goal, control }, unavailable: false }); return; }
    }
    setState({ loading: false, loaded: null, unavailable: false });
  }, [hud, hudLoaded]);

  useEffect(() => {
    void refresh();
  }, [refresh]);
  const actions = useMemo(() => state.loaded ? validActions(state.loaded) : [], [state.loaded]);

  const execute = async (action: LiaGoalControlAction) => {
    if (!state.loaded) return;
    setRunning(true); setFeedback(null);
    const result = await runLiaGoalControlAction(action, state.loaded.goal.goalId, state.loaded.control);
    await refreshCore();
    await refresh();
    setRunning(false); setPending(null);
    setFeedback(result.ok ? `${LABELS[action]} registrada. Estado durable actualizado.` : result.message);
  };
  const choose = (action: LiaGoalControlAction) => DESTRUCTIVE.has(action) ? setPending(action) : void execute(action);

  return <section className="lia-human-control-r3" aria-labelledby="lia-human-control-title">
    <header><div><span>HUMAN CONTROL SURFACE</span><h2 id="lia-human-control-title">Control humano</h2></div><b>lia-ui-operator</b></header>
    {state.loading ? <p role="status">Leyendo límites y etapa durable…</p> : state.unavailable ? <p className="is-error">Control no disponible. No se habilita ninguna acción.</p> : state.loaded ? <>
      <div className="lia-human-control-r3-context"><strong>{state.loaded.goal.title}</strong><small>{state.loaded.goal.loopStage} · política {state.loaded.control.autonomy.policyState}</small></div>
      <div className="lia-human-control-r3-actions">{actions.map((action) => <button key={action} type="button" disabled={running} className={DESTRUCTIVE.has(action) ? 'is-destructive' : undefined} onClick={() => choose(action)}>{LABELS[action]}</button>)}</div>
      <p className="lia-human-control-r3-separation">Aprobar continuación autoriza materialización. Autorizar ejecución es un permiso separado y sólo aparece cuando el backend lo permite.</p>
    </> : <p>No hay acciones humanas válidas para la etapa durable actual.</p>}
    {feedback && <p className="lia-human-control-r3-feedback" role="status">{feedback}</p>}
    {pending && <ConfirmControlDialogR3 title={LABELS[pending]} detail="Esta acción cancela o revoca una decisión durable. El estado actual se volverá a leer del backend al terminar." confirmLabel={LABELS[pending]} busy={running} onCancel={() => setPending(null)} onConfirm={() => void execute(pending)} />}
  </section>;
}
