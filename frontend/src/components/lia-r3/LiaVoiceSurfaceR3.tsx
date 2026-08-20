import type { LiaConversationController } from './liaConversationController';

type Props = { controller?: LiaConversationController; compact?: boolean };

function voiceLabel(controller?: LiaConversationController): string {
  if (!controller || !controller.voice.recognitionSupported) return 'Reconocimiento no disponible en Safari';
  if (controller.voice.state === 'listening' || controller.voice.state === 'starting') return 'Escuchando';
  if (controller.voice.state === 'speaking') return 'Hablando';
  if (controller.voice.state === 'error') return controller.voice.error ?? 'Voz no disponible';
  return 'Voz disponible';
}

export function LiaVoiceSurfaceR3({ controller, compact = false }: Props) {
  const voice = controller?.voice;
  const active = voice?.state === 'listening' || voice?.state === 'starting';
  const supported = voice?.recognitionSupported === true;
  const activate = () => {
    if (!controller || !supported) return;
    controller.openPanel();
    if (active) voice.stop(); else voice.start();
  };
  const write = () => controller?.openPanel();

  return <section className={`lia-voice-surface-r3${compact ? ' is-compact' : ''}`} aria-label="Voz y compatibilidad">
    <button
      type="button"
      className={`lia-voice-surface-r3-mic is-${voice?.state ?? 'unsupported'}`}
      onClick={activate}
      disabled={!supported || controller?.pending}
      title={supported ? (active ? 'Detener reconocimiento de voz' : 'Abrir conversación y usar voz') : 'El reconocimiento de voz no está disponible en este navegador'}
      aria-label={supported ? (active ? 'Detener reconocimiento de voz' : 'Usar voz con LÍA') : 'Voz no disponible en este navegador'}
    ><span aria-hidden="true" className="lia-voice-surface-r3-icon">◉</span></button>
    <div><span>HABLA CON LÍA</span><strong>{voiceLabel(controller)}</strong>{!compact && <small>{supported ? 'Control de micrófono del navegador' : 'Puedes usar Dictado del teclado del iPad'}</small>}</div>
    {!supported && !compact && <button type="button" className="lia-voice-surface-r3-write" onClick={write}>Escribir a LÍA</button>}
    {!compact && <dl><div><dt>Recognition</dt><dd>{supported ? 'disponible' : 'no disponible'}</dd></div><div><dt>Synthesis</dt><dd>{voice?.synthesisSupported ? 'disponible' : 'no disponible'}</dd></div></dl>}
  </section>;
}
