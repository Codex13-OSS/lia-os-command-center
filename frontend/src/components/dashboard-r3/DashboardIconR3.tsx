import type { DashboardIconNameR3 } from '../../data/dashboardShellR3Data';

type DashboardIconR3Props = {
  name: DashboardIconNameR3 | 'chevron-izquierdo' | 'chevron-derecho' | 'resize'
    | 'ruta' | 'origen' | 'destino' | 'centrar' | 'alternativa' | 'zoom-positivo'
    | 'zoom-negativo' | 'trafico' | 'reloj' | 'automovil' | 'ubicacion' | 'puntualidad';
  className?: string;
};

const paths: Record<DashboardIconR3Props['name'], React.ReactNode> = {
  inicio: <><path d="M3 10.8 12 3l9 7.8" /><path d="M5.4 9.4V21h13.2V9.4M9.4 21v-6.6h5.2V21" /></>,
  agenda: <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M8 3v4M16 3v4M3 10h18M7 14h3M14 14h3M7 18h3" /></>,
  procesos: <><circle cx="6" cy="6" r="2.5" /><circle cx="18" cy="12" r="2.5" /><circle cx="6" cy="18" r="2.5" /><path d="M8.5 6h3.2a3 3 0 0 1 3 3v0M15.5 12h-3.2a3 3 0 0 0-3 3v0" /></>,
  documentos: <><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v5h4M9 12h6M9 16h6" /></>,
  alertas: <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" /><path d="M10 21h4" /></>,
  agentes: <><circle cx="12" cy="8" r="4" /><path d="M4.5 21a7.5 7.5 0 0 1 15 0M18 5.5l2-1M6 5.5l-2-1" /></>,
  configuracion: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z" /></>,
  busqueda: <><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></>,
  campana: <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" /></>,
  mensajes: <><path d="M4 4h16v12H8l-4 4z" /><path d="M8 9h8M8 12h5" /></>,
  reunion: <><circle cx="9" cy="8" r="3" /><circle cx="17" cy="9" r="2.5" /><path d="M3.5 20a5.5 5.5 0 0 1 11 0M14 15.3a4.5 4.5 0 0 1 6.5 4" /></>,
  decision: <><path d="M12 3v18M12 6H7l-3 4 3 4h5M12 10h5l3 4-3 4h-5" /></>,
  informe: <><path d="M5 3h14v18H5z" /><path d="M9 16v-3M12 16V8M15 16v-6" /></>,
  riesgo: <><path d="M12 3 2.8 20h18.4z" /><path d="M12 9v5M12 17.5v.1" /></>,
  operador: <><circle cx="12" cy="8" r="3.5" /><path d="M5 21a7 7 0 0 1 14 0" /></>,
  'cerrar-sesion': <><path d="M10 4H5v16h5M14 8l4 4-4 4M9 12h9" /></>,
  flecha: <path d="m7 9 5 5 5-5" />,
  'metrica-reunion': <><rect x="3.25" y="5.25" width="17.5" height="15.5" rx="2.25" /><path d="M8 3.25v4M16 3.25v4M3.25 9.75h17.5M7.5 13.5h3M13.5 13.5h3M7.5 17.25h3M13.5 17.25h3" /></>,
  'metrica-decision': <><path d="M12 2.9 20 6v5.15c0 5.1-3.1 8.15-8 9.95-4.9-1.8-8-4.85-8-9.95V6z" /><circle cx="12" cy="11.3" r="3.35" /><path d="M12 9.45v3.7M10.15 11.3h3.7" /></>,
  'metrica-documento': <><path d="M5.5 2.9h8.7l4.3 4.3v13.9h-13z" /><path d="M14.2 2.9v4.8h4.3M8.6 11.4h6.8M8.6 15h6.8M8.6 18.6h4.7" /></>,
  'metrica-operacion': <><path d="M2.8 12h3.5l2-4.3 3.1 9 2.6-6.1 1.8 3.1h5.4" /><path d="M4.5 6.3A9.1 9.1 0 0 1 12 2.8a9.2 9.2 0 0 1 7.5 3.9M19.6 17.5A9.1 9.1 0 0 1 12 21.2a9.2 9.2 0 0 1-7.5-3.9" /></>,
  'chevron-izquierdo': <path d="m15 18-6-6 6-6" />,
  'chevron-derecho': <path d="m9 18 6-6-6-6" />,
  resize: <><path d="M9 5 5 9l4 4M15 5l4 4-4 4" /><path d="M5 9h14M12 3v18" /></>,
  ruta: <><circle cx="5" cy="18" r="2" /><circle cx="19" cy="6" r="2" /><path d="M7 18c7 0 3-12 10-12" /></>,
  origen: <><circle cx="12" cy="12" r="4" /><circle cx="12" cy="12" r="8" /></>,
  destino: <><path d="M12 22s7-6.3 7-13A7 7 0 0 0 5 9c0 6.7 7 13 7 13Z" /><circle cx="12" cy="9" r="2.4" /></>,
  centrar: <><circle cx="12" cy="12" r="3" /><path d="M12 2v4M12 18v4M2 12h4M18 12h4" /></>,
  alternativa: <><path d="M4 7h11M12 4l3 3-3 3M20 17H9M12 14l-3 3 3 3" /></>,
  'zoom-positivo': <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5M10.5 7.5v6M7.5 10.5h6" /></>,
  'zoom-negativo': <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5M7.5 10.5h6" /></>,
  trafico: <><path d="M7 21V3h10v18M7 8h10M7 16h10" /><circle cx="12" cy="5.5" r=".8" /><circle cx="12" cy="12" r=".8" /><circle cx="12" cy="18.5" r=".8" /></>,
  reloj: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3.5 2" /></>,
  automovil: <><path d="m5 16 1.5-6h11l1.5 6M3 16h18v4H3zM6 20v2M18 20v2" /><circle cx="7" cy="17.8" r=".7" /><circle cx="17" cy="17.8" r=".7" /></>,
  ubicacion: <><path d="M12 21s6-5.4 6-11a6 6 0 0 0-12 0c0 5.6 6 11 6 11Z" /><circle cx="12" cy="10" r="2" /></>,
  puntualidad: <><circle cx="12" cy="12" r="9" /><path d="m8 12 2.5 2.5L16.5 8" /></>,
};

export function DashboardIconR3({ name, className }: DashboardIconR3Props) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {paths[name]}
    </svg>
  );
}
