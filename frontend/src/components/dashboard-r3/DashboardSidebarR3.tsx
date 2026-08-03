import { dashboardNavigationR3 } from '../../data/dashboardShellR3Data';
import { DashboardIconR3 } from './DashboardIconR3';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { ExecutiveSectionR3 } from '../executive-r3/ExecutiveShellR3';

type DashboardSidebarR3Props = {
  activeSection: ExecutiveSectionR3;
  onDashboard: () => void;
  onAgenda: () => void;
  onTracking: () => void;
  onDocuments: () => void;
  onAlerts: () => void;
  onLogout: () => void;
  presentation: 'compact' | 'intermediate' | 'expanded';
  isResizing: boolean;
  onToggle: () => void;
  onResizeStart: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onResize: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onResizeEnd: (event: ReactPointerEvent<HTMLDivElement>) => void;
};

export function DashboardSidebarR3(props: DashboardSidebarR3Props) {
  const isCompact = props.presentation === 'compact';
  const actions: Record<string, (() => void) | undefined> = {
    dashboard: props.onDashboard,
    agenda: props.onAgenda,
    tracking: props.onTracking,
    documents: props.onDocuments,
    alerts: props.onAlerts,
  };

  return (
    <aside
      id="lia-dash-r3-sidebar"
      className={`lia-dash-r3-sidebar-shell is-${props.presentation}${isCompact ? ' lia-dash-r3-sidebar-collapsed' : ''}${props.isResizing ? ' is-resizing' : ''}`}
      data-presentation={props.presentation}
    >
      <div className="lia-dash-r3-brand">
        <div className="lia-dash-r3-brand-copy">
          <strong>LÍA O.S.</strong>
          <span>Centro de Comando<br />Ejecutivo</span>
        </div>
        <span className="lia-dash-r3-brand-mark" aria-hidden="true">LÍA</span>
      </div>

      <nav className="lia-dash-r3-navigation" aria-label="Navegación principal">
        {dashboardNavigationR3.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`lia-dash-r3-nav-item${item.id === props.activeSection ? ' lia-dash-r3-nav-item-active' : ''}`}
            onClick={actions[item.id]}
            aria-current={item.id === props.activeSection ? 'page' : undefined}
            aria-disabled={('disabled' in item && item.disabled) || undefined}
            aria-label={item.label}
            data-tooltip={item.label}
          >
            <DashboardIconR3 name={item.icon} />
            <span className="lia-dash-r3-nav-label">{item.label}</span>
            {'badge' in item && <b>{item.badge}</b>}
          </button>
        ))}
      </nav>

      <div className="lia-dash-r3-operator-tile" data-tooltip="Operador LÍA — En línea">
        <div className="lia-dash-r3-operator-core" tabIndex={isCompact ? 0 : -1} aria-label="Operador LÍA — En línea">
          <DashboardIconR3 name="operador" />
          <i className="lia-dash-r3-operator-status" aria-hidden="true" />
        </div>
        <div className="lia-dash-r3-operator-copy">
          <strong>Operador LÍA</strong>
          <span><i />En línea</span>
        </div>
        <button type="button" className="lia-dash-r3-logout" onClick={props.onLogout} aria-label="Cerrar sesión">
          <DashboardIconR3 name="cerrar-sesion" />
        </button>
        <DashboardIconR3 name="flecha" className="lia-dash-r3-operator-arrow" />
      </div>

      <button
        type="button"
        className="lia-dash-r3-sidebar-toggle"
        onClick={props.onToggle}
        aria-expanded={!isCompact}
        aria-controls="lia-dash-r3-sidebar"
        aria-label={isCompact ? 'Expandir navegación' : 'Compactar navegación'}
      >
        <DashboardIconR3 name={isCompact ? 'chevron-derecho' : 'chevron-izquierdo'} />
      </button>

      <div
        className={`lia-dash-r3-resize-handle${props.isResizing ? ' lia-dash-r3-resize-handle-active' : ''}`}
        onPointerDown={props.onResizeStart}
        onPointerMove={props.onResize}
        onPointerUp={props.onResizeEnd}
        onPointerCancel={props.onResizeEnd}
        onLostPointerCapture={props.onResizeEnd}
        onDoubleClick={props.onToggle}
        aria-hidden="true"
      />
    </aside>
  );
}
