import type {
  ExecutiveBoardDecisionLevel,
  ExecutiveBoardDecisionRequest,
  ExecutiveBoardMode,
  ExecutiveBoardRole,
} from '../contracts/executiveBoard.js';

export type ExecutiveBoardRoute = {
  level: ExecutiveBoardDecisionLevel;
  mode: ExecutiveBoardMode;
  roles: ExecutiveBoardRole[];
  reasons: Array<{ role: ExecutiveBoardRole; reason: string }>;
};

const ROLE_SIGNALS: ReadonlyArray<{
  role: Exclude<ExecutiveBoardRole, 'CEO'>;
  signals: readonly string[];
  reason: string;
}> = [
  { role: 'LEGAL', signals: ['legal', 'contrato', 'compliance', 'regulatorio', 'privacidad', 'riesgo', 'seguridad'], reason: 'Se detectó impacto legal, de compliance o riesgo.' },
  { role: 'CFO', signals: ['finanzas', 'financiero', 'presupuesto', 'coste', 'costo', 'precio', 'margen', 'ingreso', 'inversión'], reason: 'Se detectó impacto financiero o de asignación de capital.' },
  { role: 'CTO', signals: ['arquitectura', 'técnico', 'tecnico', 'software', 'infraestructura', 'api', 'datos', 'seguridad'], reason: 'Se detectó una decisión de arquitectura o tecnología.' },
  { role: 'COO', signals: ['operación', 'operacion', 'proceso', 'entrega', 'capacidad', 'proveedor', 'logística', 'logistica'], reason: 'Se detectó impacto operativo o de entrega.' },
  { role: 'CMO', signals: ['marketing', 'marca', 'cliente', 'mercado', 'campaña', 'campana', 'adquisición', 'adquisicion', 'posicionamiento'], reason: 'Se detectó impacto de mercado, marca o cliente.' },
  { role: 'DATA', signals: ['evidencia', 'métrica', 'metrica', 'experimento', 'analítica', 'analitica', 'medición', 'medicion', 'datos'], reason: 'La decisión depende explícitamente de evidencia o medición.' },
];

const LEVEL_LIMIT: Record<Exclude<ExecutiveBoardDecisionLevel, 'critical'>, number> = {
  normal: 2,
  relevant: 3,
};

function searchableText(request: ExecutiveBoardDecisionRequest): string {
  return [request.objective, ...(request.context ?? []), ...(request.riskSignals ?? [])]
    .join(' ')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('es');
}

/** Pure, deterministic advisory routing. It has no execution or authority surface. */
export function routeExecutiveBoardDecision(request: ExecutiveBoardDecisionRequest): ExecutiveBoardRoute {
  const text = searchableText(request);
  const applicable = ROLE_SIGNALS.filter(({ signals }) => signals.some((signal) => text.includes(
    signal.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('es'),
  )));

  const selected: Array<{ role: ExecutiveBoardRole; reason: string }> = [{
    role: 'CEO',
    reason: 'CEO dirige la decisión y mantiene alineación con el objetivo.',
  }];
  for (const match of applicable) {
    if (!selected.some(({ role }) => role === match.role)) selected.push({ role: match.role, reason: match.reason });
  }

  if (request.level === 'critical') {
    if (!selected.some(({ role }) => role === 'LEGAL')) {
      selected.push({ role: 'LEGAL', reason: 'BOARD MODE crítico requiere revisión explícita de riesgo y compliance.' });
    }
    if (!selected.some(({ role }) => role === 'DATA')) {
      selected.push({ role: 'DATA', reason: 'BOARD MODE crítico requiere contraste explícito con evidencia.' });
    }
  } else {
    selected.splice(LEVEL_LIMIT[request.level]);
  }

  return {
    level: request.level,
    mode: request.level === 'critical' ? 'board' : 'focused',
    roles: selected.map(({ role }) => role),
    reasons: selected,
  };
}
