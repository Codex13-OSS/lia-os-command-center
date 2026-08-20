import { useState } from 'react';
import type { ExecutivePriorityPresentationR3 } from '../../domain/executivePriorityR3';
import { quickActionsR3 } from '../../data/dashboardShellR3Data';

import { DashboardIconR3 } from './DashboardIconR3';

type LiaExecutiveRailR3Props = {
  onAgenda: () => void;
  onDocuments: () => void;
  priorityView: ExecutivePriorityPresentationR3;
  decisionsPending: number;
  criticalRisks: number;
};

export function LiaExecutiveRailR3({ onAgenda, onDocuments, priorityView, decisionsPending, criticalRisks }: LiaExecutiveRailR3Props) {
  const [showMoreActions, setShowMoreActions] = useState(false);
  const [showAllActivity, setShowAllActivity] = useState(false);
  const actionHandlers: Record<string, (() => void) | undefined> = { meeting: onAgenda, document: onDocuments };
  const priorityActions = quickActionsR3.filter(({ id }) => id === 'decision' || id === 'meeting');
  const secondaryActions = quickActionsR3.filter(({ id }) => id === 'document' || id === 'report');
  const hasCriticalOperationalItem = priorityView.criticalItems.some(({ category }) => category === 'system' || category === 'mobility');
  const executiveState = criticalRisks > 0 || hasCriticalOperationalItem
    ? { label: 'Atención crítica', tone: 'critical' }
    : decisionsPending > 0 || priorityView.priorityTransfers.length > 0 || priorityView.highItems.length > 0
      ? { label: 'Atención requerida', tone: 'attention' }
      : { label: 'Operación estable', tone: 'stable' };
  const renderAction = (action: typeof quickActionsR3[number], isTabbable = true) => (
    <button key={action.id} type="button" tabIndex={isTabbable ? undefined : -1} onClick={actionHandlers[action.id]} aria-disabled={('disabled' in action && action.disabled) || undefined}>
      <DashboardIconR3 name={action.icon} /><span>{action.label}</span>
    </button>
  );

  return (
    <aside className="lia-dash-r3-rail-shell" aria-label="Resumen de atención ejecutiva">
      <section className="lia-dash-r3-weather" aria-label="Clima no conectado">
        <span className="lia-dash-r3-weather-symbol" aria-hidden="true">○</span>
        <div>
          <strong>Clima no conectado</strong>
          <small>Sin fuente meteorológica configurada</small>
        </div>
      </section>
      <section className="lia-dash-r3-rail-summary">
        <h2>ESTADO EJECUTIVO</h2>
        <div className={`lia-dash-r3-operation-state is-${executiveState.tone}`}><i /><strong>{executiveState.label}</strong></div>
        <dl className="lia-dash-r3-attention-summary">
          <div><dt>Riesgos críticos</dt><dd>{criticalRisks}</dd></div>
          <div><dt>Decisiones pendientes</dt><dd>{decisionsPending}</dd></div>
          <div><dt>Traslado en riesgo</dt><dd>{priorityView.priorityTransfers.length}</dd></div>
        </dl>

      </section>

      <section className="lia-dash-r3-rail-actions">
        <h2>ACCIONES</h2>
        <div className="lia-dash-r3-action-grid">{priorityActions.map((action) => renderAction(action))}</div>
        <button className="lia-dash-r3-local-toggle" type="button" aria-expanded={showMoreActions} aria-controls="lia-dash-r3-more-actions" onClick={() => setShowMoreActions((current) => !current)}>
          {showMoreActions ? 'Ocultar acciones' : 'Más acciones'}
        </button>
        <div id="lia-dash-r3-more-actions" className={`lia-r3-reveal${showMoreActions ? ' lia-r3-reveal-open' : ''}`} aria-hidden={!showMoreActions}>
          <div className="lia-r3-reveal-inner lia-dash-r3-action-grid lia-dash-r3-secondary-actions">{secondaryActions.map((action) => renderAction(action, showMoreActions))}</div>
        </div>
      </section>

      <section className="lia-dash-r3-rail-activity">
        <div className="lia-dash-r3-section-heading"><h2>ATENCIÓN RECIENTE</h2></div>
        <div id="lia-dash-r3-activity-list" className="lia-dash-r3-activity-list">
          {priorityView.visibleActivities.map((item, index) => (
            <div className="lia-dash-r3-activity-row" style={{ '--lia-activity-index': index } as React.CSSProperties} key={item.id}>
              <span className={`lia-dash-r3-activity-icon lia-dash-r3-activity-${item.tone}`}><DashboardIconR3 name={item.icon as 'informe' | 'riesgo' | 'agenda'} /></span>
              <div><strong>{item.title}</strong><small>{item.detail}</small></div>
              <i className={`lia-dash-r3-status-${item.tone}`} />
            </div>
          ))}
          <div className={`lia-r3-reveal${showAllActivity ? ' lia-r3-reveal-open' : ''}`} aria-hidden={!showAllActivity}>
            <div className="lia-r3-reveal-inner">
              {priorityView.hiddenActivities.map((item) => (
                <div className="lia-dash-r3-activity-row" key={item.id}>
                  <span className={`lia-dash-r3-activity-icon lia-dash-r3-activity-${item.tone}`}><DashboardIconR3 name={item.icon as 'informe' | 'riesgo' | 'agenda'} /></span>
                  <div><strong>{item.title}</strong><small>{item.detail}</small></div>
                  <i className={`lia-dash-r3-status-${item.tone}`} />
                </div>
              ))}
            </div>
          </div>
        </div>
        <button className="lia-dash-r3-more-activity" type="button" aria-expanded={showAllActivity} aria-controls="lia-dash-r3-activity-list" onClick={() => setShowAllActivity((current) => !current)}>
          {showAllActivity ? 'Ocultar actividad informativa' : 'Ver toda la actividad'}
        </button>
      </section>
    </aside>
  );
}
