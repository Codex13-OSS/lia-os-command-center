import type { ExecutivePriorityPresentationR3 } from '../../domain/executivePriorityR3';
import type { MobilityPresentationR3, MobilitySourceStatus } from '../../domain/mobilityR3';
import { formatDashboardTimeR3 } from '../../lib/dashboardTemporalR3';

export function DashboardMobilityLowerR3({
  presentation,
  sourceStatus,
  priorityView,
}: {
  presentation: MobilityPresentationR3 | null;
  sourceStatus: MobilitySourceStatus;
  priorityView: ExecutivePriorityPresentationR3;
}) {
  if (!presentation || (sourceStatus !== 'ready' && sourceStatus !== 'stale')) {
    return <section className="lia-mobility-r3-lower lia-mobility-r3-lower-state" aria-label="Módulos de movilidad no disponibles"><p>{sourceStatus === 'loading' ? 'Preparando inteligencia de movilidad…' : 'Módulos pendientes de una fuente de movilidad válida.'}</p></section>;
  }
  const { prediction, telemetry } = presentation;
  const points = telemetry.map((snapshot, index) => {
    const x = 22 + index * (276 / Math.max(1, telemetry.length - 1));
    const y = 116 - (snapshot.trafficDurationMinutes - prediction.estimate.normalDurationMinutes) * 4;
    return `${x},${y}`;
  }).join(' ');
  const ringOffset = 264 - (264 * prediction.punctualityProbability / 100);

  return (
    <section className="lia-mobility-r3-lower" aria-label="Inteligencia de movilidad prioritaria">
      <article className={`lia-mobility-r3-module${priorityView.showTrafficModule ? '' : ' lia-mobility-r3-module-secondary'}`}>
        <header><h2>TRÁFICO Y CAMBIO RELEVANTE</h2><span>{priorityView.trafficTrend}</span></header>
        {priorityView.showTrafficModule ? <>
          <div className="lia-mobility-r3-traffic-kpi"><strong>+{prediction.trafficDelayMinutes}</strong><span>min actuales</span><em>{priorityView.trafficTrend}</em></div>
          <svg className="lia-mobility-r3-chart" viewBox="0 0 320 150" role="img" aria-label={`Retraso actual de ${prediction.trafficDelayMinutes} minutos, tendencia ${priorityView.trafficTrend}`}>
            <path className="lia-mobility-r3-chart-grid" d="M22 76H302M22 116H302" />
            <path className="lia-mobility-r3-chart-normal" d="M22 106H302" />
            <polygon points={`22,126 ${points} 298,126`} />
            <polyline points={points} />
            <circle className="lia-mobility-r3-chart-wave" cx="298" cy={116 - prediction.trafficDelayMinutes * 4} r="11" />
            <circle className="lia-mobility-r3-chart-endpoint" cx="298" cy={116 - prediction.trafficDelayMinutes * 4} r="5" />
          </svg>
          <div className="lia-mobility-r3-chart-foot"><span>Referencia normal</span><span>Cambio <b>+{priorityView.trafficChangeMinutes} min</b></span></div>
        </> : <p className="lia-mobility-r3-quiet-state">Sin cambios que requieran atención.</p>}
      </article>

      <article className="lia-mobility-r3-module">
        <header><h2>PUNTUALIDAD</h2></header>
        <div className="lia-mobility-r3-punctuality">
          <svg viewBox="0 0 100 100" role="img" aria-label={`Puntualidad: ${prediction.punctualityProbability} por ciento`}>
            <circle cx="50" cy="50" r="42" /><circle className={`lia-mobility-r3-ring lia-mobility-r3-ring-${prediction.status}`} cx="50" cy="50" r="42" style={{ strokeDashoffset: ringOffset }} />
          </svg>
          <div><strong>{prediction.punctualityProbability}%</strong><span>{presentation.statusLabel}</span></div>
        </div>
        <dl className="lia-mobility-r3-risk-details" aria-label="Cálculo ejecutivo de puntualidad">
          <div><dt>Margen</dt><dd>{prediction.marginMinutes} min</dd></div>
          <div><dt>Tiempo necesario</dt><dd>{prediction.requiredMinutes} min</dd></div>
          <div className="lia-mobility-r3-delay"><dt>Retraso por tráfico</dt><dd>+{prediction.trafficDelayMinutes} min</dd></div>
          <div><dt>Riesgo</dt><dd>{presentation.riskLabel}</dd></div>
        </dl>
      </article>

      <article className="lia-mobility-r3-module">
        <header><h2>TRASLADOS QUE REQUIEREN ATENCIÓN</h2><button type="button" disabled aria-label="Ver agenda completa, disponible en una fase posterior">Ver agenda completa</button></header>
        <div className="lia-mobility-r3-transfers lia-mobility-r3-timeline">
          {priorityView.priorityTransfers.map((transfer, index) => (
            <div className={index === 0 ? 'lia-mobility-r3-transfer-active' : undefined} key={transfer.id}>
              <time>{formatDashboardTimeR3(transfer.time)}</time>
              <p><strong>{transfer.meeting}</strong><span>{transfer.destination}</span></p>
              <small className={`lia-mobility-r3-risk-${transfer.risk}`}>{transfer.status}</small>
            </div>
          ))}
        </div>
        {priorityView.hiddenTransfers.length > 0 && <p className="lia-mobility-r3-sim-note">{priorityView.hiddenTransfers.length} traslados sin acción inmediata ocultos</p>}
      </article>
    </section>
  );
}
