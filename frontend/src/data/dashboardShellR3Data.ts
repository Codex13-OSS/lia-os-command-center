export type DashboardIconNameR3 =
  | 'inicio'
  | 'agenda'
  | 'procesos'
  | 'documentos'
  | 'alertas'
  | 'agentes'
  | 'configuracion'
  | 'busqueda'
  | 'campana'
  | 'mensajes'
  | 'reunion'
  | 'decision'
  | 'informe'
  | 'riesgo'
  | 'operador'
  | 'cerrar-sesion'
  | 'flecha'
  | 'metrica-reunion'
  | 'metrica-decision'
  | 'metrica-documento'
  | 'metrica-operacion';

export const dashboardMetricsR3 = [
  { id: 'decisions', label: 'DECISIONES PENDIENTES', value: 8 },
  { id: 'risks', label: 'RIESGOS CRÍTICOS', value: 3 },
] as const satisfies ReadonlyArray<{
  id: string;
  label: string;
  value: number;
}>;

export const dashboardNavigationR3 = [
  { id: 'dashboard', label: 'Inicio', icon: 'inicio' },
  { id: 'agenda', label: 'Agenda', icon: 'agenda' },
  { id: 'tracking', label: 'Procesos', icon: 'procesos' },
  { id: 'documents', label: 'Documentos', icon: 'documentos' },
  { id: 'alerts', label: 'Alertas', icon: 'alertas', badge: 3 },
  { id: 'agents', label: 'Agentes', icon: 'agentes', disabled: true },
  { id: 'settings', label: 'Configuración', icon: 'configuracion', disabled: true },
] as const satisfies ReadonlyArray<{
  id: string;
  label: string;
  icon: DashboardIconNameR3;
  badge?: number;
  disabled?: boolean;
}>;

export const executiveStatsR3 = [
  { label: 'SISTEMAS', value: '24', detail: 'Activos' },
  { label: 'AGENTES', value: '16', detail: 'En línea' },
  { label: 'OPERACIÓN', value: '88%', detail: 'Dentro de parámetros' },
] as const;

export const quickActionsR3 = [
  { id: 'meeting', label: 'Crear reunión', icon: 'reunion' },
  { id: 'decision', label: 'Registrar decisión', icon: 'decision', disabled: true },
  { id: 'document', label: 'Nuevo documento', icon: 'documentos' },
  { id: 'report', label: 'Generar informe', icon: 'informe', disabled: true },
] as const satisfies ReadonlyArray<{
  id: string;
  label: string;
  icon: DashboardIconNameR3;
  disabled?: boolean;
}>;

export const recentActivityR3 = [
  { id: 'daily-report', title: 'Informe operativo diario actualizado', detail: 'Actualización operativa reciente', icon: 'informe', tone: 'blue', actionRequired: false, routine: true, temporalOffsetMinutes: -15, temporalMode: 'past' },
  { id: 'critical-risk', title: 'Riesgo crítico identificado', detail: 'Requiere atención ejecutiva', icon: 'riesgo', tone: 'red', actionRequired: true, temporalOffsetMinutes: -32, temporalMode: 'past' },
  { id: 'requirement-review', title: 'Revisión de requerimiento', detail: 'Revisión programada', icon: 'agenda', tone: 'blue', actionRequired: true, dueInMinutes: 20, temporalOffsetMinutes: 20, temporalMode: 'scheduled' },
] as const satisfies ReadonlyArray<{
  id: string;
  title: string;
  detail: string;
  icon: DashboardIconNameR3;
  tone: 'blue' | 'red';
  actionRequired: boolean;
  routine?: boolean;
  dueInMinutes?: number;
  temporalOffsetMinutes: number;
  temporalMode: 'past' | 'scheduled';
}>;
