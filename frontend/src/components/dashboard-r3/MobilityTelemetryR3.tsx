import type { MobilityPredictionR3 } from '../../domain/mobilityR3';
import { formatDashboardTimeR3 } from '../../lib/dashboardTemporalR3';

export function MobilityTelemetryR3({ prediction, expanded }: { prediction: MobilityPredictionR3; expanded: boolean }) {
  const items = [
    ['Salida', formatDashboardTimeR3(prediction.recommendedDepartureTime)],
    ['ETA', formatDashboardTimeR3(prediction.estimatedArrivalTime)],
    ['Margen', `${prediction.marginMinutes} min`],
    ['Tráfico', `+${prediction.trafficDelayMinutes} min`],
  ];
  const secondaryItems = [
    ['Distancia', `${prediction.estimate.distanceKm} km`],
    ['Duración normal', `${prediction.estimate.normalDurationMinutes} min`],
    ['Duración con tráfico', `${prediction.estimate.trafficDurationMinutes} min`],
    ['Puntualidad', `${prediction.punctualityProbability}%`],
  ];

  return (
    <section className="lia-mobility-r3-telemetry" aria-label="Telemetría simulada del traslado">
      {items.map(([label, value], index) => (
        <div className={label === 'Tráfico' ? 'lia-mobility-r3-telemetry-traffic' : undefined} style={{ '--lia-telemetry-index': index } as React.CSSProperties} key={label}><span>{label}</span><strong>{value}</strong><i aria-hidden="true" /></div>
      ))}
      {expanded && secondaryItems.map(([label, value]) => (
        <div className="lia-mobility-r3-telemetry-secondary" key={label}><span>{label}</span><strong>{value}</strong><i aria-hidden="true" /></div>
      ))}
    </section>
  );
}
