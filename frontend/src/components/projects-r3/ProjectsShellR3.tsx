import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { ExecutiveShellR3 } from '../executive-r3/ExecutiveShellR3';
import type { LiaProjectTaskPriority } from '../../integrations/liaProjectTaskWorkflowClient';
import {
  LIA_GOAL_CREATED_EVENT,
  estimateLiaProjectGoalEffort,
  prepareLiaProjectGoal,
  submitLiaProjectGoal,
  type LiaProjectGoalEffortEstimate,
} from '../../integrations/liaProjectGoalClient';
import type { LiaConversationController } from '../lia-r3/liaConversationController';
import '../../styles/projectsExecutiveR3.css';
import { useLiaCoreState } from '../lia-core-r3/useLiaCoreState';
import { ProjectsAutonomyHudR3 } from '../autonomy-r3/AutonomyPanelsR3';
import { ExecutiveBoardPanelR3 } from '../autonomy-r3/ExecutiveBoardPanelR3';
import { HumanGoalControlPanelR3 } from '../autonomy-r3/HumanGoalControlPanelR3';
import { LiaVoiceSurfaceR3 } from '../lia-r3/LiaVoiceSurfaceR3';

type Props = {
  onDashboard: () => void;
  onAgenda: () => void;
  onProjects: () => void;
  onAgents: () => void; onServers: () => void;
  onSettings: () => void;
  onTracking: () => void;
  onDocuments: () => void;
  onAlerts: () => void;
  onLogout: () => void;
  conversationController?: LiaConversationController;
};

const PROJECT_ID = 'lia-hermes';
const COMPOSER_MAX_HEIGHT = 150;

type GoalTurn = {
  goalId: string;
  objective: string;
  priority: LiaProjectTaskPriority;
  createdAt: number;
  error: string | null;
  autonomyMode: AutonomyChoice;
  estimate: LiaProjectGoalEffortEstimate;
};

type AutonomyChoice = 'supervised' | 'bounded_autonomous';

const PRIORITY_OPTIONS: ReadonlyArray<{ value: LiaProjectTaskPriority; label: string }> = [
  { value: 'low', label: 'Baja' },
  { value: 'normal', label: 'Normal' },
  { value: 'high', label: 'Alta' },
  { value: 'critical', label: 'Crítica' },
];

const PRIORITY_LABELS: Record<LiaProjectTaskPriority, string> = {
  low: 'Baja',
  normal: 'Normal',
  high: 'Alta',
  critical: 'Crítica',
};

const COMPLEXITY_LABELS: Record<LiaProjectGoalEffortEstimate['complexity'], string> = {
  low: 'Baja', medium: 'Media', high: 'Alta', critical: 'Crítica',
};

function formatClock(fromMs: number): string {
  const date = new Date(fromMs);
  if (!Number.isFinite(fromMs) || Number.isNaN(date.getTime())) return 'Hora no disponible';
  try {
    return new Intl.DateTimeFormat('es-MX', { hour: '2-digit', minute: '2-digit' }).format(date);
  } catch {
    return 'Hora no disponible';
  }
}

function ConversationTurn({ turn }: { turn: GoalTurn }) {
  return (
    <>
      <article className="lia-projects-r3-msg is-user">
        <div className="lia-projects-r3-msg-bubble">
          <p>{turn.objective}</p>
          <footer>
            <span className={`lia-projects-r3-priority-chip is-${turn.priority}`}>
              Prioridad {PRIORITY_LABELS[turn.priority]}
            </span>
            <span className="lia-projects-r3-autonomy-chip">
              {turn.autonomyMode === 'bounded_autonomous' ? 'Autónoma acotada' : 'Supervisada'}
            </span>
            <span className="lia-projects-r3-autonomy-chip">Complejidad {COMPLEXITY_LABELS[turn.estimate.complexity]}</span>
            <time dateTime={new Date(turn.createdAt).toISOString()}>{formatClock(turn.createdAt)}</time>
          </footer>
        </div>
      </article>

      <article className={`lia-projects-r3-msg is-lia${turn.error ? ' is-failed' : ' is-completed'}`}>
        <div className="lia-projects-r3-lia-avatar" aria-hidden="true">LÍA</div>
        <div className="lia-projects-r3-msg-bubble">
          <header className="lia-projects-r3-msg-head"><strong>LÍA</strong></header>
          <div className="lia-projects-r3-status-copy">
            <h3>{turn.error ? 'No pude registrar el objetivo' : 'Objetivo registrado'}</h3>
            <p>{turn.error ?? 'El Goal durable ya está en control de LÍA. El HUD muestra su estado real de ejecución, espera o finalización.'}</p>
          </div>
        </div>
      </article>
    </>
  );
}

export function ProjectsShellR3(props: Props) {
  const { core, loaded: coreLoaded } = useLiaCoreState();
  const hermesUiStatus = coreLoaded
    ? core.hermesAvailability === 'available'
      ? { state: 'available' as const, label: 'Hermes disponible' as const }
      : { state: 'unavailable' as const, label: 'Hermes no disponible' as const }
    : { state: 'checking' as const, label: 'Comprobando Hermes…' as const };
  const [instruction, setInstruction] = useState('');
  const [priority, setPriority] = useState<LiaProjectTaskPriority>('normal');
  const [autonomyMode, setAutonomyMode] = useState<AutonomyChoice>('supervised');
  const [effortEstimate, setEffortEstimate] = useState<LiaProjectGoalEffortEstimate | null>(null);
  const [estimateKey, setEstimateKey] = useState('');
  const [turns, setTurns] = useState<GoalTurn[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const mountedRef = useRef(false);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const threadRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const objective = instruction.trim();
    const key = `${priority}\n${objective}`;
    if (!objective) {
      setEffortEstimate(null);
      setEstimateKey('');
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void estimateLiaProjectGoalEffort({ projectId: PROJECT_ID, objective, priority }).then((estimate) => {
        if (!cancelled) {
          setEffortEstimate(estimate);
          setEstimateKey(estimate === null ? '' : key);
        }
      });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [instruction, priority]);

  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns, notice, submitting]);

  const resizeComposer = () => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, COMPOSER_MAX_HEIGHT)}px`;
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submittingRef.current) return;
    const objective = instruction.trim();
    if (!objective) {
      setNotice('Escribe una misión concreta para LÍA.');
      return;
    }

    setNotice(null);
    submittingRef.current = true;
    setSubmitting(true);
    const currentEstimateKey = `${priority}\n${objective}`;
    let confirmedEstimate = estimateKey === currentEstimateKey ? effortEstimate : null;
    if (confirmedEstimate === null) {
      confirmedEstimate = await estimateLiaProjectGoalEffort({ projectId: PROJECT_ID, objective, priority });
    }
    if (confirmedEstimate === null) {
      if (mountedRef.current) {
        submittingRef.current = false;
        setSubmitting(false);
        setNotice('No pude confirmar la estimación y sus límites seguros. Inténtalo de nuevo.');
      }
      return;
    }
    const goal = prepareLiaProjectGoal({
      projectId: PROJECT_ID,
      objective,
      priority,
      autonomyMode,
      estimate: confirmedEstimate,
    });
    const result = await submitLiaProjectGoal(goal);
    if (!mountedRef.current) return;

    submittingRef.current = false;
    setSubmitting(false);
    if (result.kind === 'accepted') {
      setTurns((previous) => [...previous, {
        goalId: goal.request.goalId,
        objective,
        priority,
        createdAt: goal.createdAt,
        error: null,
        autonomyMode,
        estimate: confirmedEstimate,
      }]);
      setInstruction('');
      window.dispatchEvent(new Event(LIA_GOAL_CREATED_EVENT));
      window.requestAnimationFrame(resizeComposer);
      return;
    }

    const message = result.kind === 'contract'
      ? result.message
      : 'No pude confirmar si el objetivo fue registrado. La misión se conserva para que puedas reintentarlo.';
    setTurns((previous) => [...previous, {
      goalId: goal.request.goalId,
      objective,
      priority,
      createdAt: goal.createdAt,
      error: message,
      autonomyMode,
      estimate: confirmedEstimate,
    }]);
    // Contractual and ambiguous failures preserve the exact user instruction.
    setInstruction(objective);
    window.requestAnimationFrame(resizeComposer);
  };

  const handleInstructionChange = (value: string) => {
    setInstruction(value);
    window.requestAnimationFrame(resizeComposer);
  };

  const handleComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  };

  const rail = (
    <aside className="lia-dash-r3-rail-shell lia-projects-r3-rail" aria-label="Contexto del proyecto">
      <section><span>PROYECTO ACTIVO</span><strong>LÍA O.S. / Hermes</strong><small>Proyecto conectado al ejecutor local</small></section>
      <section><span>ENTORNO</span><strong>Entorno aislado</strong><small>Autorizaciones y límites controlados por LÍA</small></section>
    </aside>
  );

  return (
    <ExecutiveShellR3 {...props} activeSection="projects" mainAriaLabel="Proyectos" mainClassName="lia-projects-r3-shell" rail={rail}>
      <header className="lia-projects-r3-title">
        <div>
          <span>PROYECTOS</span>
          <h1>Proyectos</h1>
          <div className={`lia-projects-r3-live-badge is-${hermesUiStatus.state}`} role="status" aria-live="polite">
            <i aria-hidden="true" /> LÍA · {hermesUiStatus.label}
          </div>
          <p>Registra una misión y sigue sus estados reales en el HUD</p>
        </div>
      </header>

      <ProjectsAutonomyHudR3 />
      <HumanGoalControlPanelR3 />
      <ExecutiveBoardPanelR3 projectId={PROJECT_ID} />

      <section className="lia-projects-r3-chat" aria-label="Conversación con LÍA">
        <div className="lia-projects-r3-thread" ref={threadRef} role="log" aria-live="polite">
          {turns.length === 0 && !notice && (
            <div className="lia-projects-r3-welcome">
              <span className="lia-projects-r3-lia-avatar" aria-hidden="true">LÍA</span>
              <div>
                <span className="lia-projects-r3-welcome-eyebrow">LÍA ESTÁ LISTA</span>
                <strong>Describe qué quieres lograr</strong>
                <p>Registraré tu misión como un objetivo durable. Su avance aparecerá únicamente en el HUD con estados reales del backend.</p>
              </div>
            </div>
          )}
          {turns.map((turn) => <ConversationTurn key={turn.goalId} turn={turn} />)}
          {submitting && (
            <div className="lia-projects-r3-notice" role="status"><span aria-hidden="true">·</span><p>Registrando el objetivo durable…</p></div>
          )}
          {notice && (
            <div className="lia-projects-r3-notice" role="status"><span aria-hidden="true">!</span><p>{notice}</p></div>
          )}
        </div>

        <div className="lia-projects-r3-voice-access"><LiaVoiceSurfaceR3 controller={props.conversationController} /></div>
        <form className="lia-projects-r3-composer" onSubmit={submit}>
          <div className="lia-projects-r3-composer-field">
            <button type="button" className="lia-projects-r3-attach" disabled aria-label="Adjuntos próximamente" title="Adjuntos próximamente">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21.44 11.05 12.25 20.24a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.82-2.82l8.49-8.48" /></svg>
            </button>
            <textarea
              ref={composerRef}
              value={instruction}
              onChange={(event) => handleInstructionChange(event.target.value)}
              onKeyDown={handleComposerKeyDown}
              maxLength={8000}
              rows={1}
              placeholder={submitting ? 'Registrando objetivo…' : 'Escribe una misión para LÍA…'}
              aria-label="Escribe una misión para LÍA"
            />

            <button type="submit" className="lia-projects-r3-send" disabled={submitting || !instruction.trim()} aria-label={submitting ? 'Registrando objetivo' : 'Registrar objetivo'}>
              {submitting ? <span className="lia-projects-r3-send-busy" aria-hidden="true" /> : (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 19V5" /><path d="m5 12 7-7 7 7" /></svg>
              )}
            </button>
          </div>
          <div className="lia-projects-r3-composer-meta">
            <span className="lia-projects-r3-attach-note">Adjuntos próximamente</span>
            <div className="lia-projects-r3-priority" role="group" aria-label="Prioridad de la misión">
              {PRIORITY_OPTIONS.map((option) => (
                <button key={option.value} type="button" className={priority === option.value ? 'is-selected' : undefined} aria-pressed={priority === option.value} disabled={submitting} onClick={() => setPriority(option.value)}>{option.label}</button>
              ))}
            </div>
            <div className="lia-projects-r3-autonomy-select" role="group" aria-label="Autonomía del Goal">
              <button type="button" className={autonomyMode === 'supervised' ? 'is-selected' : undefined} aria-pressed={autonomyMode === 'supervised'} disabled={submitting} onClick={() => setAutonomyMode('supervised')}>Supervisada</button>
              <button type="button" className={autonomyMode === 'bounded_autonomous' ? 'is-selected' : undefined} aria-pressed={autonomyMode === 'bounded_autonomous'} disabled={submitting} onClick={() => setAutonomyMode('bounded_autonomous')}>Autónoma acotada</button>
            </div>
            {effortEstimate && estimateKey === `${priority}\n${instruction.trim()}` && (
              <span className={`lia-projects-r3-estimate is-${effortEstimate.complexity}`}>
                Complejidad {COMPLEXITY_LABELS[effortEstimate.complexity]} · {effortEstimate.recommendedMaxAttempts} intentos · profundidad {effortEstimate.recommendedContinuationDepth}
              </span>
            )}
            <span className="lia-projects-r3-composer-hint">Enter envía · Shift+Enter nueva línea</span>
          </div>
          <p className="lia-projects-r3-autonomy-help">
            {autonomyMode === 'bounded_autonomous'
              ? 'Autónoma acotada: LÍA puede corregir y reintentar dentro de límites; las acciones riesgosas siguen requiriendo humano.'
              : 'Supervisada: el primer intento corre y LÍA pide permiso para continuar.'}
          </p>
        </form>
      </section>
    </ExecutiveShellR3>
  );
}
