import { useEffect, useRef, type FormEvent, type KeyboardEvent } from 'react';
import type { LiaConversationController } from './liaConversationController';
import '../../styles/liaConversationR3.css';

type Props = {
  controller: LiaConversationController;
};

export function LiaConversationPanelR3({ controller }: Props) {
  const historyRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (controller.open) {
      historyRef.current?.scrollTo({ top: historyRef.current.scrollHeight });
    }
  }, [controller.messages, controller.open, controller.pending]);

  if (!controller.open) return null;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    controller.submit();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      controller.closePanel();
    }
  };

  return (
    <aside className="lia-conversation-r3-panel" aria-label="Conversación con LÍA">
      <header className="lia-conversation-r3-panel-header">
        <div>
          <span className="lia-conversation-r3-status-dot" aria-hidden="true" />
          <strong>LÍA</strong>
          <small>Centro de Comando</small>
        </div>
        <button type="button" onClick={controller.closePanel} aria-label="Cerrar conversación con LÍA">×</button>
      </header>

      <div className="lia-conversation-r3-history" ref={historyRef} aria-live="polite">
        {controller.messages.slice(-6).map((item, index) => (
          <article className={`lia-conversation-r3-message is-${item.role}`} key={`${item.role}-${index}-${item.text.slice(0, 18)}`}>
            <span>{item.role === 'assistant' ? 'LÍA' : 'Tú'}</span>
            <p>{item.text}</p>
          </article>
        ))}
        {controller.pending && <div className="lia-conversation-r3-processing" role="status">Procesando…</div>}
      </div>

      <form className="lia-conversation-r3-composer" onSubmit={submit}>
        <input
          aria-label="Escribe a LÍA"
          disabled={controller.pending}
          onChange={(event) => controller.setMessage(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Escribe a LÍA..."
          value={controller.message}
        />
        <button type="submit" aria-label="Enviar mensaje a LÍA" disabled={controller.pending || !controller.message.trim()}>↑</button>
      </form>
    </aside>
  );
}
