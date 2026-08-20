import { useEffect, useState } from 'react';
import { readLiaDecisionLearning, type LiaDecisionLearning } from '../../integrations/liaDecisionLearningClient';

const RESULT_LABELS: Record<string, string> = {
  successful: 'Satisfactorio observado', unsuccessful: 'No satisfactorio observado', inconclusive: 'Inconcluso',
  not_executed: 'No ejecutada', still_running: 'Goal en curso',
};
const BUCKET_LABELS = { low: 'Baja <40%', medium: 'Media 40–69%', high: 'Alta ≥70%' } as const;
const roleLabel = (role: string) => ({ CEO: 'Dirección', CFO: 'Finanzas', CTO: 'Arquitectura', CMO: 'Marketing', COO: 'Operaciones', LEGAL: 'Legal', DATA: 'Datos' }[role] ?? role);

export function DecisionLearningPanelR3({ projectId }: { projectId: string }) {
  const [learning, setLearning] = useState<LiaDecisionLearning | null | undefined>(undefined);
  useEffect(() => { let active = true; void readLiaDecisionLearning(projectId).then((value) => { if (active) setLearning(value); }); return () => { active = false; }; }, [projectId]);
  if (learning === undefined) return <section className="lia-learning-r3"><p>Derivando aprendizaje desde evidencia durable…</p></section>;
  if (learning === null) return <section className="lia-learning-r3"><p>El read model de aprendizaje no está disponible.</p></section>;
  const metrics = learning.metrics;
  return <section className="lia-learning-r3" aria-labelledby="lia-learning-title">
    <header><div><span>DECISION LEARNING V1 · SÓLO LECTURA</span><h3 id="lia-learning-title">Aprendizaje de decisiones</h3><p>Observaciones históricas; no implican causalidad ni cambian autoridad.</p></div><b>{metrics.evaluableDecisions} evaluables</b></header>
    {metrics.totalDecisions === 0 ? <div className="lia-learning-r3-empty">No hay decisiones suficientes para aprender todavía.</div> : <>
      <div className="lia-learning-r3-summary">
        <article><span>EVALUABLES</span><strong>{metrics.evaluableDecisions}</strong><small>{metrics.executedDecisions} ejecutadas vinculadas</small></article>
        <article><span>RESULTADOS OBSERVADOS</span><strong>{metrics.successfulObserved} / {metrics.unsuccessfulObserved}</strong><small>satisfactorios / no satisfactorios</small></article>
        <article><span>PENDIENTES / INCONCLUSAS</span><strong>{metrics.pending} / {metrics.inconclusive}</strong><small>sin atribución causal</small></article>
      </div>
      <div className="lia-learning-r3-sections">
        <article><span>CALIBRACIÓN OBSERVADA</span>{metrics.evaluableDecisions < learning.minimumCalibrationSample && <p>Aún no hay suficientes decisiones evaluables.</p>}<div className="lia-learning-r3-calibration">{learning.calibrationObservation.map((item) => <div key={item.bucket}><b>{BUCKET_LABELS[item.bucket]}</b><small>{item.evaluable} casos · {item.observedSuccesses} satisfactorios</small><strong>{item.sufficientSample && item.observedOutcomeRate !== undefined ? `${Math.round(item.observedOutcomeRate * 100)}% observado` : 'muestra insuficiente'}</strong></div>)}</div></article>
        <article><span>OBSERVACIONES EXPLICABLES</span>{learning.signals.length ? <ul>{learning.signals.slice(0, 6).map((signal, index) => <li key={`${signal.decisionId}-${signal.type}-${index}`}>{signal.explanation}</li>)}</ul> : <p>No hay señales justificadas en la muestra actual.</p>}</article>
        <article className="lia-learning-r3-roles"><span>PARTICIPATION OBSERVATION · SIN RANKING</span><p>Los roles de una decisión comparten el mismo resultado observado; esto no mide desempeño individual.</p><div>{learning.roleParticipationObservations.filter((item) => item.decisionsConsulted > 0).map((item) => <div key={item.role}><b>{item.role} · {roleLabel(item.role)}</b><small>{item.decisionsConsulted} consultas · {item.executedAndEvaluable} ejecutadas evaluables</small><span>{item.observedSuccessful} satisfactorias · {item.observedUnsuccessful} no satisfactorias</span></div>)}</div></article>
        <article className="lia-learning-r3-cases"><span>CASOS RECIENTES</span>{learning.cases.length ? learning.cases.slice(0, 8).map((item) => <div key={item.decisionId}><header><strong>{item.recommendation}</strong><b>{Math.round(item.boardConfidence * 100)}%</b></header><p>Outcome humano: {item.boardOutcome} · Goal: {RESULT_LABELS[item.observedResult] ?? item.observedResult}</p><small>{item.attemptCount} intentos · evaluación: {item.latestEvaluationReason ?? 'sin evidencia suficiente'} · {learning.signals.find((signal) => signal.decisionId === item.decisionId)?.type ?? item.learningStatus}</small></div>) : <p>No hay Board Decisions vinculadas a Goals en esta muestra.</p>}</article>
      </div>
    </>}
  </section>;
}
