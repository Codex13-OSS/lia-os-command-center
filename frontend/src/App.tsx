import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { CognitiveSpaceEngine } from './components/CognitiveSpaceEngine';
import { NeuralCore } from './components/NeuralCore';
import { activity, agenda, tracking } from './data/liaOsExecutiveData';
import { getExecutiveAgendaEventsForDay, getExecutiveTodayDayId } from './data/executiveAgendaData';
import { connectorPremiumStyles, mobileLÍAFixStyles, styles } from './styles/liaOsStyles';
import { ExecutiveAgendaTimeline } from './components/ExecutiveAgendaTimeline';
import { ExecutiveNextMoveCard } from './components/ExecutiveNextMoveCard';
import { ExecutivePredictivePanel } from './components/ExecutivePredictivePanel';
import { PremiumAlertsView } from './components/PremiumAlertsView';
import { TrackingCommandView } from './components/TrackingCommandView';
import { ExecutiveEnvironmentCard } from './components/ExecutiveEnvironmentCard';
import { DynamicCommandLayer } from './components/DynamicCommandLayer';
import { LiaAgentBridgeStatusCard } from './components/LiaAgentBridgeStatusCard';
import { LiaAgentBackendStatusCard } from './components/LiaAgentBackendStatusCard';
import { LiaLoginScreen } from './components/LiaLoginScreen';
import { requestLiaHermesResponse } from './integrations/liaHermesChatClient';
import { DashboardShellR3 } from './components/dashboard-r3/DashboardShellR3';
import { AgendaShellR3 } from './components/agenda-r3/AgendaShellR3';
import { ProjectsShellR3 } from './components/projects-r3/ProjectsShellR3';
import type { LiaConversationController } from './components/lia-r3/liaConversationController';
import './styles/agendaExecutiveR3.css';

type View = 'dashboard' | 'agenda' | 'projects' | 'tracking' | 'documents' | 'alerts';

const DOCUMENT_GENERATOR_URL = 'http://38.242.222.25:3023';
const agendaR3Enabled = true;
const liaConversationR3Enabled = true;

export default function App() {
  const [logged, setLogged] = useState(false);
  const [loginEmail, setLoginEmail] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [loginError, setLoginError] = useState<string | null>(null);
  const [view, setView] = useState<View>('dashboard');
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [liaState, setLÍAState] = useState('En línea');
  const [message, setMessage] = useState('');
  const [, setLÍALog] = useState([
    'Núcleo cognitivo iniciado.',
    'Centro ejecutivo listo.',
    'Esperando instrucción ejecutiva.',
  ]);
  const [activityFeed, setActivityFeed] = useState(activity);
  const [livePulse, setLivePulse] = useState(0);
  const [liaMessages, setLÍAMessages] = useState<Array<{ role: 'user' | 'assistant'; text: string }>>([
    {
      role: 'assistant',
      text: 'Centro ejecutivo listo. Puedo ayudarte con agenda, prioridades y seguimiento.',
    },
  ]);
  const [hideTabletLÍAFloat, setHideTabletLÍAFloat] = useState(false);
  const [mobileOrbListening, setMobileOrbListening] = useState(false);
  const [mobileLÍAOpen, setMobileLÍAOpen] = useState(false);
  const [activeLiaAction, setActiveLiaAction] = useState<string | null>(null);
  const [liaQueryPending, setLiaQueryPending] = useState(false);
  const [liaPanelOpen, setLiaPanelOpen] = useState(false);
  const liaQueryPendingRef = useRef(false);
  const mobileInputRef = useRef<HTMLInputElement | null>(null);
  const orbTimeoutRef = useRef<number | null>(null);

  const viewContext: Record<View, string> = {
    dashboard: 'Centro ejecutivo',
    agenda: 'Agenda ejecutiva',
    projects: 'Proyectos',
    tracking: 'Seguimiento operativo',
    documents: 'Documentos',
    alerts: 'Alertas',
  };

  const currentExecutiveEvents = getExecutiveAgendaEventsForDay(getExecutiveTodayDayId());
  const currentNextMove = currentExecutiveEvents.find((event) => event.status !== 'libre');

  const buildContextualResult = (instruction: string, fallback: string) => {
    const lower = instruction.toLowerCase();
    const context = viewContext[view];

    if (lower.includes('abrir documento')) {
      return `${context}: documento abierto con estado, responsable y decisión pendiente.`;
    }

    if (lower.includes('priorizar')) {
      return `${context}: prioridad elevada. LÍA conectó alerta, responsable y siguiente cierre.`;
    }

    if (lower.includes('validación') || lower.includes('validar')) {
      return `${context}: validación registrada. Queda pendiente confirmación humana y criterio de cierre.`;
    }

    if (lower.includes('resumen') || lower.includes('guion')) {
      return `${context}: resumen listo con objetivo, riesgos, preguntas clave y salida esperada.`;
    }

    if (lower.includes('recordatorio') || lower.includes('alerta')) {
      return `${context}: alerta preparada con origen, estado y acción recomendada.`;
    }

    if (lower.includes('bloquear') || lower.includes('reservar')) {
      return `${context}: bloque reservado para cerrar pendiente con responsable y resultado esperado.`;
    }

    if (lower.includes('responsable') || lower.includes('seguimiento') || lower.includes('frente')) {
      return `${context}: seguimiento conectado. LÍA identificó responsable, riesgo y próximo movimiento.`;
    }

    if (lower.includes('estado')) {
      return `${context}: estado actualizado con prioridad, riesgo y continuidad operativa.`;
    }

    return `${context}: ${fallback}`;
  };

  const pushLÍALog = (text: string) => {
    const time = new Date().toLocaleTimeString('es-MX', {
      hour: '2-digit',
      minute: '2-digit',
    });

    setLÍALog((prev) => [`${time} · ${text}`, ...prev].slice(0, 6));
  };

  const addActivity = (text: string) => {
    setActivityFeed((prev) => [text, ...prev].slice(0, 5));
  };

  const openDocumentGenerator = () => {
    window.open(DOCUMENT_GENERATOR_URL, '_blank', 'noopener,noreferrer');
  };



  const runLÍAAction = (instruction: string, result: string, onConfirm?: () => void) => {
    const flowContext = viewContext[view];
    const contextualResult = buildContextualResult(instruction, result);

    setActiveLiaAction(instruction);
    setLÍAState('Leyendo contexto');
    setLÍAMessages((current) => [
      ...current.slice(-5),
      { role: 'user' as const, text: instruction },
      { role: 'assistant' as const, text: `Leyendo ${flowContext.toLowerCase()}, intención y siguiente movimiento...` },
    ]);

    window.setTimeout(() => {
      setLÍAState('Registrando acción');
      setLÍAMessages((current) => {
        const next = [...current];
        const last = next[next.length - 1];

        if (last?.role === 'assistant' && last.text.startsWith('Leyendo ')) {
          next[next.length - 1] = { role: 'assistant' as const, text: contextualResult };
          return next.slice(-6);
        }

        return [...next, { role: 'assistant' as const, text: contextualResult }].slice(-6);
      });
      pushLÍALog(`${flowContext} · ${instruction} · conectado`);
      setLivePulse((pulse) => (pulse + 1) % 8);
      onConfirm?.();

      window.setTimeout(() => {
        setLÍAState('En línea');
        setActiveLiaAction(null);
      }, 1200);
    }, 520);
  };

  const handleModuleActionCapture = (event: MouseEvent<HTMLElement>) => {
    const target = event.target as HTMLElement | null;
    const button = target?.closest('button');

    if (!button) return;

    if (
      button.closest('.quick-actions') ||
      button.closest('.cockpit-decision-actions-v090') ||
      button.closest('.document-card')
    ) {
      return;
    }

    const rawLabel = button.textContent?.replace(/\s+/g, ' ').trim();

    if (!rawLabel) return;

    const moduleActions: Record<string, string> = {
      Resumen: 'Resumen de evento preparado: contexto, riesgos y acuerdos sugeridos.',
      Recordatorio: 'Recordatorio operativo registrado para la siguiente ventana ejecutiva.',
      Guion: 'Guion ejecutivo abierto: objetivo, preguntas clave y salida esperada.',
      Revisar: 'Revisión ejecutiva iniciada: LÍA priorizó contexto, estado y siguiente acción.',
      Validar: 'Validación ejecutiva registrada: pendiente de confirmación ejecutiva final.',
      'Depurar alertas': 'Alertas depuradas. LÍA conserva la lectura prioritaria del centro ejecutivo.',
      'Confirmar responsables de proceso crítico.': 'Responsables del proceso crítico listos para confirmación y cierre.',
      'Generar resumen ejecutivo antes de junta de dirección.': 'Resumen ejecutivo preparado con decisiones, riesgos y puntos de cierre.',
      'Validar documento comercial pendiente.': 'Documento comercial enviado a validación con criterio de cierre.',
      'Bloquear espacio de revisión estratégica.': 'Bloque estratégico preparado para revisión y seguimiento.',
      'Agendar reunión': 'Reunión ejecutiva agendada: LÍA preparó contexto, responsable, ubicación y siguiente acción.',
    };

    let label = rawLabel;
    let result = moduleActions[rawLabel] ?? '';
    let activityText = `${label}: acción ejecutiva registrada.`;

    const alertCard = button.closest('.alert-premium-card');
    const trackingLane = button.closest('.tracking-lane-card');
    const trackingAction = button.closest('.tracking-actions-panel');
    const availableSlot = button.closest('.available-slots');
    const agendaAction = button.closest('.agenda-event-actions');

    if (trackingLane) {
      const laneName = trackingLane.querySelector('.tracking-lane-top span')?.textContent?.trim() ?? 'Frente operativo';
      const laneStatus = trackingLane.querySelector('.tracking-lane-top strong')?.textContent?.trim() ?? 'Estado activo';

      label = `Abrir frente: ${laneName}`;
      result = `Seguimiento operativo: frente ${laneName} abierto. Estado ${laneStatus}. LÍA preparó responsable, riesgo y próximo movimiento.`;
      activityText = `${laneName}: frente operativo revisado.`;
    } else if (alertCard && (rawLabel === 'Revisar' || rawLabel === 'Validar')) {
      const alertTitle = alertCard.querySelector('h4')?.textContent?.trim() ?? 'Alerta ejecutiva';

      label = `${rawLabel} alerta: ${alertTitle}`;
      result = `Alertas: ${alertTitle}. LÍA vinculó origen, estado y criterio de validación.`;
      activityText = `${alertTitle}: ${rawLabel.toLowerCase()} registrado.`;
    } else if (availableSlot) {
      const slotLabel = button.querySelector('strong')?.textContent?.trim() ?? 'Bloque disponible';
      const slotTime = button.querySelector('span')?.textContent?.trim() ?? 'Horario abierto';

      label = `Reservar bloque: ${slotLabel}`;
      result = `Agenda ejecutiva: bloque ${slotTime} reservado para ${slotLabel}. LÍA preparó objetivo y salida esperada.`;
      activityText = `${slotLabel}: bloque reservado en agenda.`;
    } else if (agendaAction && moduleActions[rawLabel]) {
      const eventCard = button.closest('.agenda-event-card');
      const eventTitle = eventCard?.querySelector('h5')?.textContent?.trim() ?? 'Junta ejecutiva';

      label = `${rawLabel}: ${eventTitle}`;
      result = `${moduleActions[rawLabel]} Evento: ${eventTitle}.`;
      activityText = `${eventTitle}: ${rawLabel.toLowerCase()} preparado.`;
    } else if (trackingAction && !result) {
      result = `Seguimiento operativo: movimiento preparado. ${rawLabel}`;
      activityText = `${rawLabel}: movimiento recomendado registrado.`;
    }

    if (!result) return;

    button.classList.add('lia-simulated-feedback-v090', 'cockpit-action-active-v090');

    window.setTimeout(() => {
      button.classList.remove('cockpit-action-active-v090');
    }, 1400);

    runLÍAAction(label, result, () => addActivity(activityText));
  };

  const sendLÍA = async () => {
    const clean = message.trim();

    if (!clean || liaQueryPendingRef.current) return;

    const pendingText = 'Consultando el núcleo de LÍA...';

    liaQueryPendingRef.current = true;
    setLiaQueryPending(true);
    setActiveLiaAction(clean);
    setLÍAState('Procesando');
    setMessage('');
    setLÍAMessages((current) => [
      ...current.slice(-4),
      { role: 'user' as const, text: clean },
      { role: 'assistant' as const, text: pendingText },
    ].slice(-6));

    try {
      const result = await requestLiaHermesResponse(clean);
      const responseText = result.ok ? result.response : result.message;

      setLÍAMessages((current) => {
        const next = [...current];

        for (let index = next.length - 1; index >= 0; index -= 1) {
          const item = next[index];

          if (item.role === 'assistant' && item.text === pendingText) {
            next[index] = {
              role: 'assistant',
              text: responseText,
            };
            return next.slice(-6);
          }
        }

        return [
          ...next,
          {
            role: 'assistant' as const,
            text: responseText,
          },
        ].slice(-6);
      });

      if (result.ok) {
        pushLÍALog(`Hermes · ${result.model} · respuesta recibida`);
        addActivity(
          `LÍA respondió: ${clean.length > 44 ? `${clean.slice(0, 44)}…` : clean}`,
        );
      } else {
        pushLÍALog('Hermes · consulta no completada');
      }
    } finally {
      liaQueryPendingRef.current = false;
      setLiaQueryPending(false);
      setActiveLiaAction(null);
      setLÍAState('En línea');
    }
  };

  const liaConversationController: LiaConversationController = {
    message,
    messages: liaMessages,
    pending: liaQueryPending,
    open: liaPanelOpen,
    setMessage,
    submit: () => {
      setLiaPanelOpen(true);
      void sendLÍA();
    },
    openPanel: () => setLiaPanelOpen(true),
    closePanel: () => setLiaPanelOpen(false),
  };

  const closeMobileLÍA = () => {
    setMobileLÍAOpen(false);
    setMobileOrbListening(false);
    setLÍAState('En línea');
    if (orbTimeoutRef.current) window.clearTimeout(orbTimeoutRef.current);
  };

  const activateMobileOrb = () => {
    if (mobileLÍAOpen) {
      closeMobileLÍA();
      return;
    }

    if (orbTimeoutRef.current) window.clearTimeout(orbTimeoutRef.current);
    setMobileLÍAOpen(true);
    setMobileOrbListening(true);
    setLÍAState('Escuchando...');
    setLÍAMessages((prev) => {
      const prompt = { role: 'assistant' as const, text: 'Indica prioridad, documento o alerta.' };
      const last = prev[prev.length - 1];

      if (last?.role === prompt.role && last.text === prompt.text) {
        return prev;
      }

      return [...prev, prompt].slice(-6);
    });
    pushLÍALog('Interacción móvil activada.');
    window.setTimeout(() => mobileInputRef.current?.focus(), 120);
    orbTimeoutRef.current = window.setTimeout(() => {
      setMobileOrbListening(false);
      setLÍAState('En línea');
    }, 2400);
  };

  useEffect(() => () => {
    if (orbTimeoutRef.current) window.clearTimeout(orbTimeoutRef.current);
  }, []);

  useEffect(() => {
    const tabletWidthQuery = window.matchMedia('(min-width: 768px) and (max-width: 1366px)');
    const coarseTabletQuery = window.matchMedia('(pointer: coarse) and (min-width: 768px)');
    const syncTabletLÍAFloat = () => {
      const shouldHide = tabletWidthQuery.matches || coarseTabletQuery.matches;

      setHideTabletLÍAFloat(shouldHide);
      if (shouldHide) {
        setMobileLÍAOpen(false);
        setMobileOrbListening(false);
      }
    };

    syncTabletLÍAFloat();
    tabletWidthQuery.addEventListener('change', syncTabletLÍAFloat);
    coarseTabletQuery.addEventListener('change', syncTabletLÍAFloat);

    return () => {
      tabletWidthQuery.removeEventListener('change', syncTabletLÍAFloat);
      coarseTabletQuery.removeEventListener('change', syncTabletLÍAFloat);
    };
  }, []);

  if (!logged) {
    return (
      <LiaLoginScreen
        email={loginEmail}
        password={loginPassword}
        error={loginError}
        onEmailChange={setLoginEmail}
        onPasswordChange={setLoginPassword}
        onSubmit={() => {
          if (loginEmail !== 'ejecutivo@lia.local' || loginPassword !== 'lia2026') {
            setLoginError('Credenciales de acceso: ejecutivo@lia.local / lia2026');
            return;
          }

          setLoginError(null);
          setLogged(true);
        }}
      />
    );
  }

  if ((() => view === 'dashboard')()) {
    return (
      <DashboardShellR3
        onDashboard={() => setView('dashboard')}
        onAgenda={() => setView('agenda')}
        onProjects={() => setView('projects')}
        onTracking={() => setView('tracking')}
        onDocuments={openDocumentGenerator}
        onAlerts={() => setView('alerts')}
        onLogout={() => setLogged(false)}
        conversationController={liaConversationR3Enabled ? liaConversationController : undefined}
      />
    );
  }

  if (view === 'agenda' && agendaR3Enabled) {
    return <AgendaShellR3 onDashboard={() => setView('dashboard')} onAgenda={() => setView('agenda')} onProjects={() => setView('projects')} onTracking={() => setView('tracking')} onDocuments={openDocumentGenerator} onAlerts={() => setView('alerts')} onLogout={() => setLogged(false)} />;
  }

  if (view === 'projects') {
    return <ProjectsShellR3 onDashboard={() => setView('dashboard')} onAgenda={() => setView('agenda')} onProjects={() => setView('projects')} onTracking={() => setView('tracking')} onDocuments={openDocumentGenerator} onAlerts={() => setView('alerts')} onLogout={() => setLogged(false)} conversationController={liaConversationR3Enabled ? liaConversationController : undefined} />;
  }

  const nav = [
    ['dashboard', 'Inicio'],
    ['agenda', 'Agenda'],
    ['projects', 'Proyectos'],
    ['tracking', 'Seguimiento'],
    ['documents', 'Generador de documentos'],
    ['alerts', 'Alertas'],
  ] as const;

  const handleMobileNavLink = (id: View) => {
    setMobileNavOpen(false);

    if (id === 'documents') {
      openDocumentGenerator();
      return;
    }

    setView(id);
  };

  return (
    <>
    <main className="os-shell">
      <style>{styles}</style>
        <style>{connectorPremiumStyles}</style>
        <style>{mobileLÍAFixStyles}</style>


      <button
        type="button"
        className="mobile-nav-toggle"
        aria-label="Abrir navegación principal"
        aria-expanded={mobileNavOpen}
        onClick={() => setMobileNavOpen(true)}
      >
        <span />
        <span />
        <span />
        <strong>Menú</strong>
      </button>

      {mobileNavOpen && (
        <div className="mobile-nav-layer" role="presentation">
          <button
            type="button"
            className="mobile-nav-backdrop"
            aria-label="Cerrar navegación"
            onClick={() => setMobileNavOpen(false)}
          />

          <nav className="mobile-nav-drawer" aria-label="Navegación móvil LÍA O.S">
            <div className="mobile-nav-head">
              <div className="login-brand-mark">LÍA</div>
              <div>
                <strong>LÍA O.S</strong>
                <span>Centro ejecutivo</span>
              </div>
              <button
                type="button"
                className="mobile-nav-close"
                aria-label="Cerrar menú"
                onClick={() => setMobileNavOpen(false)}
              >
                ×
              </button>
            </div>

            <div className="mobile-nav-links">
              {nav.map(([id, label]) => (
                <button
                  key={`mobile-${id}`}
                  type="button"
                  className={view === id ? 'mobile-nav-link active' : 'mobile-nav-link'}
                  onClick={() => handleMobileNavLink(id)}
                >
                  <span>{label}</span>
                  <em>{view === id ? 'Activo' : 'Abrir'}</em>
                </button>
              ))}
            </div>
          </nav>
        </div>
      )}

      <aside className="sidebar">
        <div>
          <div className="logo">LÍA O.S</div>
          <p className="side-sub">Centro de mando ejecutivo</p>
        </div>

        <nav>
          {nav.map(([id, label]) => (
            <button
              key={id}
              className={view === id ? 'nav-item active' : 'nav-item'}
              onClick={() => {
                if (id === 'documents') {
                  openDocumentGenerator();
                  return;
                }
                setView(id);
              }}
            >
              <span>◆</span>{label}
            </button>
          ))}
        </nav>

        <div className="system-status">
          <span className="dot" />
          LÍA activo
        </div>
      </aside>

      <section className="main-panel executive-interaction-layer-v090 lia-visual-executive-refinement-v092 lia-executive-minimalism-v093 lia-label-minimal-fix-v093 lia-responsive-executive-v094 lia-orb-premium-v095 lia-executive-intelligence-v096 lia-visual-density-v097 lia-module-content-v098 lia-interaction-flow-v099 lia-cognitive-visual-system-v112 lia-cognitive-space-engine-v130" onClickCapture={handleModuleActionCapture}>
        <header className="topbar">
          <div>
            <p className="eyebrow">CENTRO EJECUTIVO</p>
            <h2>{view === 'dashboard' ? 'Centro de mando ejecutivo' : nav.find(([id]) => id === view)?.[1]}</h2>
          </div>
          <ExecutiveEnvironmentCard variant="compact" />
          <button className="secondary" onClick={() => setLogged(false)}>Cerrar sesión</button>
        </header>

        {view === 'dashboard' && (
          <section className="executive-cockpit-layout-v088 executive-cockpit-layout-v112">
            <section className="dashboard-command-strip-v112 dashboard-command-strip-v120">
              <ExecutiveNextMoveCard event={currentNextMove} />
              <ExecutivePredictivePanel events={currentExecutiveEvents} variant="dashboard" />
            </section>
            <section className="kpi-grid executive-first-screen-v087 executive-cockpit-kpis-v088">
              <div className="card kpi info"><p>En foco hoy</p><strong>4</strong><span>2 decisiones preparadas</span></div>
              <div className="card kpi critical"><p>Por resolver</p><strong>8</strong><span>3 requieren confirmación</span></div>
              <div className="card kpi warning"><p>Generador de documentos</p><strong>FSV/CNE</strong><span>Módulo activo en 3023</span></div>
              <div className="card kpi stable live-card"><p>Ritmo del día</p><strong>{87 + Math.min(livePulse, 6)}%</strong><span>{livePulse > 0 ? 'actualizada por LÍA' : 'operación bajo control'}</span></div>
            </section>

            <section className="executive-cockpit-main-v088">
              <article className="panel cognitive-compact-stage-v088">
                <div className="cockpit-section-head-v088">
                  <p className="eyebrow">ESTADO DE LÍA</p>
                  <strong>Vista general del día</strong>
                </div>
                <CognitiveSpaceEngine />
              </article>

              <aside className="panel risk-priority-panel cockpit-decision-core-v088">
                <div className="risk-priority-head">
                  <p className="eyebrow">PRIORIDADES DEL DÍA</p>
                  <strong>Prioridad ejecutiva del día</strong>
                </div>
                <div className="risk-priority-list">
                  <article>
                    <em className="critical">Crítico</em>
                    <span>Reunión de dirección requiere confirmación y síntesis.</span>
                    <small>Pendiente para hoy.</small>
                    <b>Acción: confirmar responsable, criterio y hora de cierre.</b>
                  </article>
                  <article>
                    <em className="warning">Prioridad</em>
                    <span>Propuesta comercial lista para cierre.</span>
                    <small>Lista para cierre.</small>
                    <b>Acción: validar versión final y preparar aprobación.</b>
                  </article>
                <div className="cockpit-decision-actions-v090">
                  {[
                    ['Preparar resumen', 'Resumen del día preparado con contexto y decisiones pendientes.'],
                    ['Confirmar responsable', 'Responsable confirmado para el siguiente movimiento.'],
                    ['Solicitar validación', 'Solicitud enviada para validación de dirección.'],
                    ['Crear seguimiento', 'Seguimiento creado para asegurar cierre.'],
                  ].map(([label, result]) => (
                    <button
                      key={label}
                      className={`lia-simulated-feedback-v090 ${activeLiaAction === label ? 'cockpit-action-active-v090' : ''}`}
                      onClick={() => runLÍAAction(label, result, () => addActivity(`${label}: acción ejecutiva registrada.`))}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                </div>
              </aside>
            </section>

            <section className="cockpit-secondary-grid-v088">
              <DynamicCommandLayer
                onExecuteCommand={(command) =>
                  runLÍAAction(
                    command.label,
                    `${command.label}: comando ejecutivo preparado en modo seguro.`,
                    () => addActivity(`${command.label}: ${command.feedback.toLowerCase()}.`),
                  )
                }
              />

              <LiaAgentBridgeStatusCard />
              <LiaAgentBackendStatusCard />

              <div className="panel cockpit-agenda-card-v088">
                <p className="eyebrow">AGENDA EJECUTIVA</p>
                {agenda.map(([time, title, priority]) => (
                  <div className="row" key={title}>
                    <b>{time}</b>
                    <span>{title}</span>
                    <em>{priority}</em>
                  </div>
                ))}
              </div>

              <div className="panel cockpit-tracking-card-v088">
                <p className="eyebrow">SEGUIMIENTO CLAVE</p>
                {tracking.map(([name, pct, status]) => (
                  <div className="track" key={name}>
                    <div><span>{name}</span><b>{status}</b></div>
                    <div className="bar"><i style={{ width: `${pct}%` }} /></div>
                  </div>
                ))}
              </div>

              <div className="panel activity cockpit-activity-card-v088">
                <p className="eyebrow">RESUMEN DEL DÍA</p>
                {activityFeed.map((item, index) => <div className="activity-item" key={`${item}-${index}`}>{item}</div>)}
              </div>
            </section>
          </section>
        )}

        {view === 'agenda' && <ExecutiveAgendaTimeline />}

        {view === 'tracking' && <TrackingCommandView legacyTracking={tracking} />}

        {view === 'alerts' && <PremiumAlertsView />}

      </section>

      <aside className="lia-panel lia-panel-compact-v087 lia-executive-copilot-v088 lia-cognitive-rail-v112 lia-voice-ready-panel-v411">
        <div className="lia-voice-core-v411">
          <div className="lia-orb">
            <NeuralCore />
          </div>
          <div className="lia-voice-title-v411">
            <p className="eyebrow">ASISTENTE EJECUTIVO</p>
            <h3>LÍA en línea</h3>
            <span>Lista para escuchar y asistir.</span>
          </div>
        </div>

        <section className={`lia-listen-state-v411 ${liaState.toLowerCase().replace(/\s+/g, '-')}`}>
          <span />
          <div>
            <strong>Modo escucha preparado</strong>
            <small>Activación por voz en próxima fase.</small>
          </div>
        </section>

        <div className="lia-voice-command-v411">
          <div className="lia-input">
            <input
              value={message}
              disabled={liaQueryPending}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void sendLÍA()}
              placeholder={liaQueryPending ? "LÍA está procesando..." : "Habla con LÍA..."}
            />
            <button aria-label="Enviar instrucción a LÍA" disabled={liaQueryPending} onClick={() => void sendLÍA()}>↗</button>
          </div>
          <small>Escribe o prepara una instrucción.</small>
        </div>

        <section className="lia-response-panel-v411">
          <p className="eyebrow">ÚLTIMA RESPUESTA</p>
          <strong>{liaQueryPending ? 'LÍA está procesando...' : 'Respuesta de LÍA'}</strong>
          <span>
            {[...liaMessages]
              .reverse()
              .find((item) => item.role === 'assistant')?.text ||
              'Puedo ayudarte con agenda, prioridades y seguimiento.'}
          </span>
        </section>

        <div className="quick-actions lia-context-actions-v411">
          <button
            className={`lia-simulated-feedback-v090 ${activeLiaAction === 'Preparar resumen' ? 'cockpit-action-active-v090' : ''}`}
            onClick={() =>
              runLÍAAction(
                'Preparar resumen',
                'Resumen listo: prioridades, riesgos, responsables y cierre sugerido.',
                () => addActivity('Resumen ejecutivo del día preparado.')
              )
            }
          >
            Preparar resumen
          </button>
          <button
            className={`lia-simulated-feedback-v090 ${activeLiaAction === 'Revisar agenda' ? 'cockpit-action-active-v090' : ''}`}
            onClick={() =>
              runLÍAAction(
                'Revisar agenda',
                'Agenda revisada: bloques clave, prioridad y siguiente movimiento preparados.',
                () => addActivity('Agenda ejecutiva revisada por LÍA.')
              )
            }
          >
            Revisar agenda
          </button>
          <button
            className={`lia-simulated-feedback-v090 ${activeLiaAction === 'Crear seguimiento' ? 'cockpit-action-active-v090' : ''}`}
            onClick={() =>
              runLÍAAction(
                'Crear seguimiento',
                'Seguimiento preparado: responsable, riesgo y cierre sugerido listos.',
                () => addActivity('Seguimiento ejecutivo preparado.')
              )
            }
          >
            Crear seguimiento
          </button>
        </div>

        <div className="lia-presence-matrix-v112 lia-operational-compact-v411">
          <article>
            <span>Agenda</span>
            <strong>Activa</strong>
          </article>
          <article>
            <span>Riesgo</span>
            <strong>Medio</strong>
          </article>
          <article>
            <span>Acciones</span>
            <strong>Listas</strong>
          </article>
        </div>
      </aside>
    </main>
    {!hideTabletLÍAFloat && (
      <button
        type="button"
        className={`mobile-lia-orb mobile-lia-floating-control ${mobileOrbListening ? 'listening' : ''}`}
        aria-label={mobileLÍAOpen ? 'Cerrar panel móvil de LÍA' : 'Abrir panel móvil de LÍA'}
        aria-expanded={mobileLÍAOpen}
        onClick={activateMobileOrb}
      >
        <span className="mobile-lia-orb-label" aria-hidden="true" />
      </button>
    )}
    {!hideTabletLÍAFloat && mobileLÍAOpen && (
      <section className="mobile-lia-panel mobile-lia-floating-panel" role="dialog" aria-label="LÍA móvil">
        <div className="mobile-lia-header">
          <div>
            <p className="eyebrow">LÍA O.S</p>
            <strong>Comando rápido</strong>
          </div>

          <button
            type="button"
            className="mobile-lia-close"
            aria-label="Cerrar LÍA móvil"
            onClick={closeMobileLÍA}
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>

        <div className="mobile-lia-stream">
          {liaMessages.slice(-3).map((item, index, visibleMessages) => (
            <div className={`lia-bubble ${item.role} ${item.role === 'assistant' && index === visibleMessages.length - 1 ? 'lia-action-response-v090' : ''}`} key={`mobile-${item.role}-${index}-${item.text}`}>
              {item.text}
            </div>
          ))}
        </div>

        <div className="lia-input mobile">
          <input
            ref={mobileInputRef}
            value={message}
            disabled={liaQueryPending}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void sendLÍA()}
            placeholder={liaQueryPending ? "LÍA está procesando..." : "Habla con LÍA..."}
          />
          <button disabled={liaQueryPending} onClick={() => void sendLÍA()}>↑</button>
        </div>
      </section>
    )}
    </>
  );
}
