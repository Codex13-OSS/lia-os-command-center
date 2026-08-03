import { useState } from 'react';
import { formatDashboardTimeR3 } from '../../lib/dashboardTemporalR3';
import type { MobilityPresentationR3, MobilitySourceStatus, MobilityTrafficProfile } from '../../domain/mobilityR3';
import { DashboardIconR3 } from './DashboardIconR3';
import { MobilityTelemetryR3 } from './MobilityTelemetryR3';

const profileLabels: Record<MobilityTrafficProfile, string> = {
  fluid: 'Fluido',
  current: 'Actual',
  heavy: 'Pesado',
};

const sourceStatusLabels: Record<MobilitySourceStatus, string> = {
  loading: 'Preparando movilidad',
  ready: 'Información disponible',
  stale: 'Información pendiente de actualización',
  error: 'No fue posible obtener movilidad',
  missing_origin: 'Falta definir el origen',
  missing_destination: 'Falta definir el destino',
  no_route: 'No existe una ruta disponible',
  provider_not_configured: 'Proveedor no configurado',
};

export function MobilityMapR3({
  profile,
  presentation,
  sourceStatus,
  onProfileChange,
}: {
  profile: MobilityTrafficProfile;
  presentation: MobilityPresentationR3 | null;
  sourceStatus: MobilitySourceStatus;
  onProfileChange: (profile: MobilityTrafficProfile) => void;
}) {
  const [zoom, setZoom] = useState(1);
  const [showAlternative, setShowAlternative] = useState(true);
  const [showDetails, setShowDetails] = useState(false);
  const prediction = presentation?.prediction;
  const isReady = prediction && (sourceStatus === 'ready' || sourceStatus === 'stale');
  const hasAlternative = Boolean(prediction?.estimate.alternativeRoutes.length);

  return (
    <section className="lia-mobility-r3-map" aria-label="Previsualización cartográfica simulada del próximo traslado">
      <div className="lia-mobility-r3-map-scan" aria-hidden="true" />
      <div className="lia-mobility-r3-simulation">
        <strong>{presentation?.metadata.providerMode === 'live' ? 'TRÁFICO EN VIVO' : 'MODO SIMULACIÓN'}</strong>
        <span>{presentation?.metadata.providerName ?? 'Proveedor cartográfico pendiente'}</span>
        <em>{sourceStatusLabels[sourceStatus]}</em>
        <div className="lia-mobility-r3-endpoint-summary">
          {prediction
            ? `${prediction.origin.name} → ${prediction.meeting.destination.name}`
            : 'Ruta ejecutiva pendiente'}
        </div>
      </div>

      <div className="lia-mobility-r3-map-controls" aria-label="Controles del mapa simulado">
        <button type="button" aria-label="Centrar ruta" onClick={() => setZoom(1)}><DashboardIconR3 name="centrar" /></button>
        <button type="button" aria-label={`${showAlternative ? 'Ocultar' : 'Mostrar'} ruta alternativa`} aria-pressed={showAlternative && hasAlternative} disabled={!hasAlternative} onClick={() => setShowAlternative((visible) => !visible)}><DashboardIconR3 name="alternativa" /></button>
        <button type="button" aria-label="Acercar mapa" onClick={() => setZoom((value) => Math.min(1.25, +(value + .05).toFixed(2)))}><DashboardIconR3 name="zoom-positivo" /></button>
        <button type="button" aria-label="Alejar mapa" onClick={() => setZoom((value) => Math.max(.9, +(value - .05).toFixed(2)))}><DashboardIconR3 name="zoom-negativo" /></button>
      </div>

      <svg className="lia-mobility-r3-map-surface" viewBox="0 0 1000 520" preserveAspectRatio="xMidYMid slice" role="img" aria-label="Mapa esquemático simulado entre Oficina Central y Centro de Convenciones">
        <defs>
          <linearGradient id="mobility-land-r3" x1="0" y1="0" x2="1" y2="1"><stop stopColor="#102536" /><stop offset=".48" stopColor="#091a28" /><stop offset="1" stopColor="#05111d" /></linearGradient>
          <linearGradient id="mobility-water-r3" x1="0" y1="0" x2=".8" y2="1"><stop stopColor="#061a29" /><stop offset=".6" stopColor="#03111d" /><stop offset="1" stopColor="#020a12" /></linearGradient>
          <linearGradient id="mobility-route-r3" x1="180" y1="375" x2="820" y2="140" gradientUnits="userSpaceOnUse"><stop stopColor="#5baeff" /><stop offset=".52" stopColor="#7ec8ff" /><stop offset="1" stopColor="#a4dbff" /></linearGradient>
          <radialGradient id="mobility-destination-r3"><stop stopColor="#f5fbff" /><stop offset=".34" stopColor="#a8ddff" /><stop offset="1" stopColor="#278fdf" /></radialGradient>
          <pattern id="mobility-grid-r3" width="28" height="28" patternUnits="userSpaceOnUse"><path d="M28 0H0V28" fill="none" stroke="#6c9abc" strokeOpacity=".045" strokeWidth=".7" /></pattern>
          <pattern id="mobility-grain-r3" width="17" height="17" patternUnits="userSpaceOnUse"><circle cx="2" cy="3" r=".7" fill="#b9ddf5" opacity=".06" /><circle cx="12" cy="10" r=".5" fill="#4f7895" opacity=".08" /></pattern>
          <filter id="mobility-shadow-r3" x="-25%" y="-25%" width="150%" height="160%"><feDropShadow dx="0" dy="8" stdDeviation="9" floodColor="#000812" floodOpacity=".52" /></filter>
          <filter id="mobility-glow-r3" x="-30%" y="-80%" width="160%" height="260%"><feGaussianBlur stdDeviation="6" result="blur" /><feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
          <filter id="mobility-node-glow-r3" x="-150%" y="-150%" width="400%" height="400%"><feGaussianBlur stdDeviation="4" result="blur" /><feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
        </defs>
        <g className="lia-mobility-r3-map-zoom" style={{ transform: `scale(${zoom})` }}>
          <rect width="1000" height="520" fill="url(#mobility-land-r3)" />
          <g className="lia-mobility-r3-terrain">
            <path d="M-35 38 247-20l116 114-56 181-338 42z" />
            <path d="m292-24 342 7 57 155-146 152-245-78z" />
            <path d="m-20 324 380-58 177 254H-20z" />
            <path d="m543 277 188-108 134 102-47 269H502z" />
          </g>
          <path className="lia-mobility-r3-water" d="M724-30C653 68 713 151 642 229c-60 66-33 142-103 311h501V-30Z" />
          <path className="lia-mobility-r3-shoreline" d="M724-30C653 68 713 151 642 229c-60 66-33 142-103 311" />
          <g className="lia-mobility-r3-parks">
            <path d="m72 79 138-24 56 76-44 96-153-29z" />
            <path d="m375 349 96-49 88 73-20 96-139 7z" />
          </g>
          <g className="lia-mobility-r3-blocks" filter="url(#mobility-shadow-r3)">
            <path d="m305 44 91 5 16 60-78 20zM438 55l108-8 18 72-118 25zM97 262l112-14 17 53-123 18zM262 337l98-24 26 67-106 32zM570 92l58-20 24 66-69 28zM565 327l94-43 37 62-106 55z" />
          </g>
          <g className="lia-mobility-r3-urban-lights" aria-hidden="true">
            <circle cx="270" cy="178" r="2" /><circle cx="314" cy="205" r="1.5" /><circle cx="356" cy="153" r="1.8" />
            <circle cx="403" cy="194" r="1.4" /><circle cx="455" cy="167" r="2.2" /><circle cx="492" cy="215" r="1.5" />
            <circle cx="531" cy="178" r="1.7" /><circle cx="575" cy="205" r="1.3" /><circle cx="612" cy="168" r="2" />
            <circle cx="326" cy="286" r="1.5" /><circle cx="374" cy="265" r="1.8" /><circle cx="424" cy="292" r="1.3" />
            <circle cx="475" cy="273" r="2" /><circle cx="526" cy="302" r="1.6" /><circle cx="581" cy="275" r="1.4" />
            <circle cx="635" cy="245" r="1.9" /><circle cx="684" cy="211" r="1.4" /><circle cx="735" cy="181" r="2.1" />
            <circle cx="228" cy="326" r="1.4" /><circle cx="678" cy="324" r="1.5" />
          </g>
          <g className="lia-mobility-r3-optical-underlay" aria-hidden="true">
            <path className="lia-mobility-r3-optical-secondary" d="M-30 104C92 112 194 164 307 181S423 188 482 222" />
            <path className="lia-mobility-r3-optical-secondary" d="M118-20C136 84 174 170 218 250s47 148 62 290M342 302c98 38 178 91 271 130s230 51 417 28" />
            <path className="lia-mobility-r3-optical-main" d="M-42 292C106 263 213 286 338 335s236 120 356 125 220-25 352-8" />
            <path className="lia-mobility-r3-optical-block" d="m264 126 126 18 58 91-52 82-151-36-34-91z" />
            <path className="lia-mobility-r3-optical-block" d="m632 389 177-31 116 70-38 111-204 13-82-72z" />
            <circle className="lia-mobility-r3-optical-light" cx="104" cy="143" r="3" />
            <circle className="lia-mobility-r3-optical-light" cx="238" cy="224" r="2.6" />
            <circle className="lia-mobility-r3-optical-light" cx="690" cy="446" r="3" />
            <circle className="lia-mobility-r3-optical-light" cx="842" cy="476" r="2.4" />
            <path className="lia-mobility-r3-optical-boundary" d="M-35 246C91 215 188 229 291 267s194 99 306 107 184-27 286-12 123 49 181 61" />
          </g>
          <rect width="1000" height="520" fill="url(#mobility-grid-r3)" />
          <rect width="1000" height="520" fill="url(#mobility-grain-r3)" />
          <g className="lia-mobility-r3-secondary-streets">
            <path d="M-20 126 310 176 612 120 1010 165M-30 356 250 310 560 372 1010 325M110-10l45 540M342-10l-25 540M570-10l54 540M810-10l-42 540M-5 61l335 68 306-34M23 442l265-79 330 98" />
            <path d="M35 235 244 253 438 225 655 292M185 30l85 472M440 8l-42 492M68 198l268 34 271-80M252-10l-9 161M706 37l-24 473M494 12l97 188M68 488l238-61" />
          </g>
          <g className="lia-mobility-r3-main-streets">
            <path className="lia-mobility-r3-avenue-edge" d="M-40 430C180 382 305 388 493 287S775 110 1040 82M78 540C194 350 356 330 465 194S710 36 838-30" />
            <path d="M-40 430C180 382 305 388 493 287S775 110 1040 82M78 540C194 350 356 330 465 194S710 36 838-30" />
          </g>
          <g className="lia-mobility-r3-map-labels" aria-hidden="true">
            <text x="355" y="182">DISTRITO FINANCIERO</text><text x="716" y="238">RIBERA NORTE</text><text x="55" y="338">AV. CENTRAL</text>
          </g>
          {hasAlternative && <g className={`lia-mobility-r3-route-alternative-group${showAlternative ? ' lia-mobility-r3-route-alternative-visible' : ''}`}>
            <path className="lia-mobility-r3-route-alternative-underlay" d="M180 375C255 310 344 350 430 275S617 183 820 140" />
            <path className="lia-mobility-r3-route-alternative" d="M180 375C255 310 344 350 430 275S617 183 820 140" />
          </g>}
          <path className="lia-mobility-r3-route-glow" d="M180 375C245 345 288 290 385 303S520 224 606 238 720 161 820 140" />
          <path className="lia-mobility-r3-route-bed" d="M180 375C245 345 288 290 385 303S520 224 606 238 720 161 820 140" />
          <path className="lia-mobility-r3-route" d="M180 375C245 345 288 290 385 303S520 224 606 238 720 161 820 140" />
          <g className="lia-mobility-r3-route-directions" aria-hidden="true">
            <path d="m292 296 12 2-8 9" />
            <path d="m431 285 12-5-3 11" />
            <path d="m571 235 12-1-6 10" />
            <path d="m705 181 11-6-2 12" />
          </g>
          <g className="lia-mobility-r3-map-node lia-mobility-r3-origin" transform={`translate(${(prediction?.origin.mapX ?? 18) * 10} ${(prediction?.origin.mapY ?? 72) * 5.2})`}><circle className="lia-mobility-r3-origin-halo" r="18" /><circle className="lia-mobility-r3-node-core" r="6" /><circle className="lia-mobility-r3-node-center" r="2" /><text x="18" y="24">{prediction?.origin.name ?? 'Origen pendiente'}</text></g>
          <g className="lia-mobility-r3-map-node lia-mobility-r3-midpoint" transform="translate(500 245)"><circle className="lia-mobility-r3-midpoint-activity" r="17" /><circle className="lia-mobility-r3-midpoint-halo" r="13" /><circle className="lia-mobility-r3-node-core" r="5" /><path className="lia-mobility-r3-transfer-mark" d="m-3-1 3-3 3 3M3 2 0 5l-3-3" /><text x="-42" y="-18">Estación Central</text></g>
          <g className="lia-mobility-r3-map-node lia-mobility-r3-destination" transform={`translate(${(prediction?.meeting.destination.mapX ?? 82) * 10} ${(prediction?.meeting.destination.mapY ?? 27) * 5.2})`}><circle className="lia-mobility-r3-location-halo" r="31" /><circle className="lia-mobility-r3-destination-ring" r="16" /><circle className="lia-mobility-r3-node-core" r="9" /><circle className="lia-mobility-r3-node-center" r="3" /><text x="-142" y="42">{prediction?.meeting.destination.name ?? 'Destino pendiente'}</text></g>
        </g>
      </svg>

      {!isReady && (
        <div className={`lia-mobility-r3-source-state lia-mobility-r3-source-${sourceStatus}`} role={sourceStatus === 'error' ? 'alert' : 'status'}>
          <DashboardIconR3 name={sourceStatus === 'loading' ? 'reloj' : 'ruta'} />
          <strong>{sourceStatusLabels[sourceStatus]}</strong>
          <span>{sourceStatus === 'loading' ? 'Cargando snapshot normalizado…' : 'La interfaz no sustituye este estado con datos simulados.'}</span>
        </div>
      )}
      {isReady && <article className={`lia-mobility-r3-meeting lia-mobility-r3-status-${prediction.status}${showDetails ? ' lia-mobility-r3-meeting-expanded' : ''}`}>
        <span className={`lia-mobility-r3-status-ribbon is-${prediction?.status ?? 'pending'}`}>{presentation?.statusLabel ?? 'PENDIENTE DE CÁLCULO'}</span>
        <header><span>PRÓXIMA REUNIÓN</span><strong>{formatDashboardTimeR3(prediction.meeting.startTime)}</strong></header>
        <h2>{prediction.meeting.title}</h2>
        <p><DashboardIconR3 name="destino" />{prediction.meeting.destination.name}<small>{prediction.meeting.destination.shortAddress}</small></p>
        <div className="lia-mobility-r3-primary-status"><span>Estado</span><strong>{presentation.statusLabel}</strong></div>
        <dl className="lia-mobility-r3-decision-values">
          <div><dt>Salida recomendada</dt><dd>{formatDashboardTimeR3(prediction.recommendedDepartureTime)}</dd></div>
          <div><dt>ETA</dt><dd>{formatDashboardTimeR3(prediction.estimatedArrivalTime)}</dd></div>
          <div><dt>Margen</dt><dd>{prediction.marginMinutes} min</dd></div>
        </dl>
        <button className="lia-mobility-r3-details-toggle" type="button" aria-expanded={showDetails} aria-controls="lia-mobility-r3-transfer-details" onClick={() => setShowDetails((current) => !current)}>
          {showDetails ? 'Ocultar detalles' : 'Ver detalles del traslado'}
        </button>
        <div id="lia-mobility-r3-transfer-details" className={`lia-r3-reveal${showDetails ? ' lia-r3-reveal-open' : ''}`} aria-hidden={!showDetails}>
          <div className="lia-r3-reveal-inner lia-mobility-r3-transfer-details">
            <dl>
              <div><dt>Distancia</dt><dd>{prediction.estimate.distanceKm} km</dd></div>
              <div><dt>Duración normal</dt><dd>{prediction.estimate.normalDurationMinutes} min</dd></div>
              <div><dt>Con tráfico</dt><dd>{prediction.estimate.trafficDurationMinutes} min</dd></div>
              <div><dt>Retraso</dt><dd>+{prediction.trafficDelayMinutes} min</dd></div>
            </dl>
            <div className="lia-mobility-r3-buffers" aria-label="Buffers incluidos en el cálculo">
              <span>Estacionamiento <b>{prediction.estimate.parkingMinutes} min</b></span>
              <span>Caminata <b>{prediction.estimate.walkingMinutes} min</b></span>
              <span>Preparación <b>{prediction.estimate.preparationMinutes} min</b></span>
            </div>
            <p>Ruta alternativa: {prediction.estimate.alternativeRoutes[0]?.label ?? 'No disponible'}</p>
            <p>Proveedor: {presentation.metadata.providerName} · {sourceStatusLabels[sourceStatus]}</p>
            <div className="lia-mobility-r3-profile" aria-label="Perfil de tráfico simulado">
              {(Object.keys(profileLabels) as MobilityTrafficProfile[]).map((item) => (
                <button type="button" key={item} tabIndex={showDetails ? undefined : -1} aria-pressed={profile === item} onClick={() => onProfileChange(item)}>{profileLabels[item]}</button>
              ))}
            </div>
          </div>
        </div>
      </article>}
      {isReady && <MobilityTelemetryR3 prediction={prediction} expanded={showDetails} />}
    </section>
  );
}
