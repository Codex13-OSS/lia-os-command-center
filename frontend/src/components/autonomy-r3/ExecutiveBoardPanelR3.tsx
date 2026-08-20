import { useCallback, useEffect, useState } from 'react';
import {
  prepareLiaBoardTransition,
  readLatestExecutiveBoardDecision,
  submitLiaBoardTransition,
  type LiaBoardOutcomeStatus,
  type LiaExecutiveBoardDecision,
  type LiaExecutiveBoardRole,
} from '../../integrations/liaExecutiveBoardClient';
import { ConfirmControlDialogR3 } from './ConfirmControlDialogR3';
import { DecisionLearningPanelR3 } from './DecisionLearningPanelR3';

const ROLE_NAMES: Record<LiaExecutiveBoardRole, string> = {
  CEO: 'Dirección',
  CFO: 'Finanzas',
  CTO: 'Arquitectura',
  CMO: 'Marketing',
  COO: 'Operaciones',
  LEGAL: 'Legal & riesgo',
  DATA: 'Datos & evidencia',
};

function BoardDecisionView({ decision, busy, feedback, onAction }: { decision: LiaExecutiveBoardDecision; busy: boolean; feedback: string | null; onAction: (status: LiaBoardOutcomeStatus) => void }) {
  const actions: Array<{ status: LiaBoardOutcomeStatus; label: string; destructive?: boolean }> = decision.outcome.status === 'pending'
    ? [{ status: 'approved', label: 'Aprobar recomendación' }, { status: 'rejected', label: 'Rechazar recomendación', destructive: true }]
    : decision.outcome.status === 'approved'
      ? [{ status: 'executed', label: 'Marcar ejecutada' }, { status: 'superseded', label: 'Superseder', destructive: true }]
      : [];
  return (
    <div className="lia-board-r3-decision">
      <div className="lia-board-r3-specialists" aria-label="Especialistas convocados">
        {decision.rolesConsulted.map((role) => {
          const perspective = decision.perspectives.find((item) => item.role === role);
          return (
            <div key={role} className={`is-${perspective?.status ?? 'failed'}`}>
              <span>{role}</span>
              <strong>{ROLE_NAMES[role]}</strong>
              <small>{perspective?.status === 'completed' ? 'Perspectiva completa' : perspective?.status === 'blocked_missing_data' ? 'Faltan datos' : 'No completada'}</small>
            </div>
          );
        })}
      </div>

      <div className="lia-board-r3-grid">
        <article className="lia-board-r3-recommendation">
          <span>RECOMENDACIÓN</span>
          <h3>{decision.recommendation}</h3>
          <p>{decision.objective}</p>
          <div className="lia-board-r3-confidence">
            <span>Confianza</span>
            <strong>{Math.round(decision.confidence * 100)}%</strong>
            <i aria-hidden="true"><b style={{ transform: `scaleX(${Math.max(0, Math.min(1, decision.confidence))})` }} /></i>
          </div>
        </article>

        <article className={`lia-board-r3-approval ${decision.requiresHumanApproval ? 'is-required' : ''}`}>
          <span>APROBACIÓN HUMANA</span>
          <strong>{decision.requiresHumanApproval ? 'Requerida' : 'No requerida'}</strong>
          <p>{decision.requiresHumanApproval ? 'LÍA no avanzará por decisión de la Junta sin autorización humana.' : 'La Junta no añadió un gate; siguen vigentes los límites de ejecución de LÍA.'}</p>
          <small>Outcome · {decision.outcome.status}</small>
          <p className="lia-board-r3-separation"><b>Decisión ejecutiva ≠ autorización operativa.</b> Cambiar este outcome no ejecuta, no concede capabilities y no crea un Goal.</p>
          {actions.length > 0 && <div className="lia-board-r3-actions">{actions.map((action) => <button key={action.status} type="button" className={action.destructive ? 'is-destructive' : undefined} disabled={busy} onClick={() => onAction(action.status)}>{action.label}</button>)}</div>}
          {feedback && <p className="lia-board-r3-feedback" role="status">{feedback}</p>}
        </article>

        <article className={`lia-board-r3-tension ${decision.disagreements.length > 0 ? 'has-tension' : ''}`}>
          <span>TENSIÓN / DESACUERDO</span>
          {decision.disagreements.length > 0 ? decision.disagreements.map((item) => (
            <div key={item.disagreementId}>
              <strong>{item.issue}</strong>
              {item.positions.map((position) => <p key={position.role}><b>{position.role}</b> {position.position}</p>)}
              <small>{item.resolution === 'unresolved' ? 'Sin resolver' : item.resolution}</small>
            </div>
          )) : <p>No se registraron desacuerdos en esta decisión.</p>}
        </article>

        <article className="lia-board-r3-signals">
          <div><span>RIESGOS</span>{decision.risks.length > 0 ? <ul>{decision.risks.map((risk) => <li key={risk}>{risk}</li>)}</ul> : <p>Sin riesgos registrados.</p>}</div>
          <div><span>DATOS FALTANTES</span>{decision.missingData.length > 0 ? <ul>{decision.missingData.map((item) => <li key={item}>{item}</li>)}</ul> : <p>Sin datos faltantes registrados.</p>}</div>
          <div><span>EVIDENCIA</span><strong>{decision.evidence.length}</strong><p>{decision.evidence.length > 0 ? 'referencias durables vinculadas' : 'Sin evidencia vinculada.'}</p></div>
        </article>
      </div>
    </div>
  );
}

export function ExecutiveBoardPanelR3({ projectId }: { projectId: string }) {
  const [state, setState] = useState<{ loading: boolean; durable: boolean; decision: LiaExecutiveBoardDecision | null }>({
    loading: true,
    durable: false,
    decision: null,
  });
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<LiaBoardOutcomeStatus | null>(null);

  const refresh = useCallback(async () => {
    const result = await readLatestExecutiveBoardDecision(projectId);
    setState({ loading: false, ...result });
  }, [projectId]);
  useEffect(() => { let active = true; void readLatestExecutiveBoardDecision(projectId).then((result) => { if (active) setState({ loading: false, ...result }); }); return () => { active = false; }; }, [projectId]);

  const execute = async (status: LiaBoardOutcomeStatus) => {
    if (!state.decision) return;
    setBusy(true); setFeedback(null);
    const prepared = prepareLiaBoardTransition(state.decision, status);
    const result = await submitLiaBoardTransition(prepared);
    await refresh();
    setBusy(false); setConfirming(null);
    setFeedback(result.ok ? 'Outcome durable actualizado. No se inició ninguna ejecución.' : result.message);
  };
  const choose = (status: LiaBoardOutcomeStatus) => ['rejected', 'superseded'].includes(status) ? setConfirming(status) : void execute(status);

  return (
    <section className="lia-board-r3" aria-labelledby="lia-board-r3-title">
      <header className="lia-board-r3-head">
        <div>
          <span>LÍA EXECUTIVE BOARD · V1</span>
          <h2 id="lia-board-r3-title">Junta ejecutiva</h2>
          <p>Consulta especializada, evidencia y tensión preservada.</p>
        </div>
        <div className="lia-board-r3-mode">
          <small>{state.decision?.mode === 'board' ? 'BOARD MODE' : state.decision ? 'MODO FOCALIZADO' : 'SIN DECISIÓN'}</small>
          <strong>{state.decision ? `${state.decision.rolesConsulted.length} roles` : '—'}</strong>
        </div>
      </header>

      {state.loading ? (
        <div className="lia-board-r3-empty" role="status"><i aria-hidden="true" /><strong>Consultando registro de Junta…</strong></div>
      ) : state.decision ? (
        <BoardDecisionView decision={state.decision} busy={busy} feedback={feedback} onAction={choose} />
      ) : (
        <div className="lia-board-r3-empty">
          <div className="lia-board-r3-empty-mark" aria-hidden="true"><span /><span /><span /></div>
          <div>
            <strong>No existe una Board Decision real</strong>
            <p>Este proyecto aún no tiene una decisión ejecutiva registrada. No se muestran especialistas, recomendaciones ni evidencia simulada.</p>
            <small>{state.durable ? 'Registro durable conectado · 0 decisiones' : 'Registro de Junta no configurado'}</small>
          </div>
        </div>
      )}
      <DecisionLearningPanelR3 projectId={projectId} />
      {confirming && <ConfirmControlDialogR3 title={confirming === 'rejected' ? 'Rechazar recomendación' : 'Superseder decisión'} detail="Sólo cambiará el outcome durable del Board. No se tocará ningún Goal ni autorización operativa." confirmLabel={confirming === 'rejected' ? 'Rechazar' : 'Superseder'} busy={busy} onCancel={() => setConfirming(null)} onConfirm={() => void execute(confirming)} />}
    </section>
  );
}
