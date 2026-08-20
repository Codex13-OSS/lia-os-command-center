export type DashboardIconNameR3 =
  | 'inicio'
  | 'agenda'
  | 'procesos'
  | 'documentos'
  | 'alertas'
  | 'agentes'
  | 'servidores'
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

export const dashboardNavigationR3 = [
  { id: 'dashboard', label: 'Inicio', icon: 'inicio' },
  { id: 'agenda', label: 'Agenda', icon: 'agenda' },
  { id: 'projects', label: 'Proyectos', icon: 'procesos' },
  { id: 'agents', label: 'Oficina', icon: 'agentes' },
  { id: 'servers', label: 'Servidores', icon: 'servidores' },
  { id: 'documents', label: 'Documentos', icon: 'documentos' },
  { id: 'settings', label: 'Configuración', icon: 'configuracion' },
] as const satisfies ReadonlyArray<{
  id: string;
  label: string;
  icon: DashboardIconNameR3;
  badge?: number;
  disabled?: boolean;
}>;

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
