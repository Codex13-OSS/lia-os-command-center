import type { ExecutiveMetricR3 } from '../../domain/executivePriorityR3';
import { formatDashboardTimeR3 } from '../../lib/dashboardTemporalR3';
import { DashboardIconR3 } from './DashboardIconR3';

export function DashboardMetricsR3({ metrics }: { metrics: readonly ExecutiveMetricR3[] }) {
  return (
    <section className="lia-dash-r3-metric-frames" aria-label="Métricas ejecutivas prioritarias">
      {metrics.map((metric, index) => {
        const value = metric.id === 'next-meeting' || metric.id === 'departure'
          ? formatDashboardTimeR3(metric.value)
          : metric.value;
        return (
          <article
            className={`lia-dash-r3-metric-card lia-dash-r3-priority-${metric.level}`}
            style={{ '--lia-metric-index': index } as React.CSSProperties}
            aria-label={`${metric.label}: ${value}. Estado: ${metric.stateLabel}. ${metric.description}`}
            key={metric.id}
          >
            <span className="lia-dash-r3-metric-icon"><DashboardIconR3 name={metric.icon} /></span>
            <div className="lia-dash-r3-metric-copy">
              <h2>{metric.label}</h2>
              <strong>{value}</strong>
              <p>{metric.description}</p>
            </div>
            <span className="lia-dash-r3-metric-state" aria-hidden="true">
              <i className="lia-dash-r3-priority-mark" />
              <b>{metric.stateLabel}</b>
            </span>
          </article>
        );
      })}
    </section>
  );
}
