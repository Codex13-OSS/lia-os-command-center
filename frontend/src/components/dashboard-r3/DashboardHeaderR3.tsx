import type { FormEvent, KeyboardEvent } from 'react';
import { formatClockTimeR3, formatExecutiveDateR3 } from '../../lib/dashboardTemporalR3';
import type { LiaConversationController } from '../lia-r3/liaConversationController';
import { DashboardIconR3 } from './DashboardIconR3';

type Props = {
  now: Date;
  conversationController?: LiaConversationController;
  onLogout?: () => void;
};

export function DashboardHeaderR3({ now, conversationController, onLogout }: Props) {
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    conversationController?.submit();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      conversationController?.closePanel();
    }
  };

  return (
    <header className="lia-dash-r3-header-shell">
      {conversationController ? (
        <form className="lia-dash-r3-search" role="search" aria-label="Conversar con LÍA" onSubmit={submit}>
          <input
            aria-label="Buscar en LÍA"
            disabled={conversationController.pending}
            onChange={(event) => conversationController.setMessage(event.target.value)}
            onFocus={conversationController.openPanel}
            onKeyDown={handleKeyDown}
            placeholder="Buscar en LÍA..."
            value={conversationController.message}
          />
          <button type="submit" aria-label="Enviar consulta a LÍA" disabled={conversationController.pending || !conversationController.message.trim()}>
            <DashboardIconR3 name="busqueda" />
          </button>
        </form>
      ) : (
        <div className="lia-dash-r3-search" role="search">
          <DashboardIconR3 name="busqueda" />
          <span>Buscar en LÍA...</span>
        </div>
      )}
      <div className="lia-dash-r3-focus">
        <strong>FOCO EJECUTIVO</strong>
        <span>Solo información prioritaria</span>
      </div>
      <div className="lia-dash-r3-temporal-context" aria-label={`Fecha y hora actual: ${formatExecutiveDateR3(now)}, ${formatClockTimeR3(now)}`}>
        <span>{formatExecutiveDateR3(now)}</span>
        <time dateTime={now.toISOString()}>{formatClockTimeR3(now)}</time>
      </div>
      <div className="lia-dash-r3-header-controls">
        <button type="button" aria-label="Notificaciones">
          <DashboardIconR3 name="campana" />
        </button>
        <button type="button" aria-label="Mensajes"><DashboardIconR3 name="mensajes" /></button>
        <span className="lia-dash-r3-avatar">OL</span>
        {onLogout && (
          <button type="button" className="lia-dash-r3-header-logout" aria-label="Cerrar sesión" onClick={onLogout}>
            <DashboardIconR3 name="cerrar-sesion" />
          </button>
        )}
        <button type="button" aria-label="Abrir menú de operador"><DashboardIconR3 name="flecha" /></button>
      </div>
    </header>
  );
}
