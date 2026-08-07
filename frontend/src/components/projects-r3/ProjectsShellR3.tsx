import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { ExecutiveShellR3 } from '../executive-r3/ExecutiveShellR3';
import { type LiaProjectTaskPriority } from '../../integrations/liaProjectTaskWorkflowClient';
import {
  clearPersistedProjectTask,
  getProjectTaskStatus,
  loadPersistedProjectTask,
  persistProjectTaskStatus,
  prepareProjectTask,
  submitProjectTask,
  type LiaProjectTaskReceipt,
  type LiaProjectTaskStage,
  type PersistedProjectTask,
} from '../../integrations/liaProjectTaskClient';
import type { LiaConversationController } from '../lia-r3/liaConversationController';
import '../../styles/projectsExecutiveR3.css';

type Props = {
  onDashboard: () => void;
  onAgenda: () => void;
  onProjects: () => void;
  onTracking: () => void;
  onDocuments: () => void;
  onAlerts: () => void;
  onLogout: () => void;
  conversationController?: LiaConversationController;
};

const PROJECT_ID = 'lia-hermes';
const POLL_INTERVAL_MS = 1500;
const TEMPORARY_RETRY_MS = 2500;
const COMPOSER_MAX_HEIGHT = 150;

type ProjectStageKey = LiaProjectTaskStage | 'recovering';

type StageMeta = {
  human: string;
  detail: string;
};

/** Textos humanos para cada estado público del flujo (sin jerga técnica). */
const STAGE_META: Record<ProjectStageKey, StageMeta> = {
  accepted: {
    human: 'Recibí tu solicitud',
    detail: 'Estoy validando tu instrucción y el proyecto antes de empezar.',
  },
  planning: {
    human: 'Estoy organizando el trabajo',
    detail: 'Preparo el plan mínimo y verifico el entorno aislado.',
  },
  hermes: {
    human: 'Estoy analizando y decidiendo cómo hacerlo',
    detail: 'Defino el enfoque y la secuencia de cambios necesarios.',
  },
  codex: {
    human: 'Estoy trabajando en los archivos',
    detail: 'Aplico los cambios dentro de un entorno aislado y seguro.',
  },
  verification: {
    human: 'Estoy comprobando que todo funcione',
    detail: 'Ejecuto las verificaciones autorizadas sobre el resultado.',
  },
  commit: {
    human: 'Estoy guardando el resultado',
    detail: 'Registro el cambio verificado de forma local.',
  },
  completed: {
    human: 'Trabajo terminado',
    detail: 'El resultado final ya está disponible abajo.',
  },
  failed: {
    human: 'No pude completar esta parte',
    detail: 'Algo no salió como esperaba; revisa el diagnóstico seguro.',
  },
  recovering: {
    human: 'Estoy recuperando tu última tarea',
    detail: 'LÍA está recuperando el último estado confirmado de la tarea.',
  },
};

const IDLE_STAGE = {
  eyebrow: 'LÍA ESTÁ LISTA',
  human: 'Describe qué quieres lograr',
  detail: 'La ejecución aparecerá aquí usando únicamente estados reales del backend.',
};

const WORKFLOW_STEPS = [
  { technical: 'planning', label: 'Preparando', human: 'Organizando el trabajo' },
  { technical: 'hermes', label: 'Hermes', human: 'Analizando el enfoque' },
  { technical: 'codex', label: 'Ejecutando', human: 'Trabajando en los archivos' },
  { technical: 'verification', label: 'Verificando', human: 'Comprobando que todo funcione' },
  { technical: 'commit', label: 'Guardando', human: 'Guardando el resultado' },
] as const;

type StepState = 'pending' | 'active' | 'completed' | 'failed';

function progressFor(stage: ProjectStageKey | null): StepState[] {
  if (stage === 'failed') return WORKFLOW_STEPS.map(() => 'failed');
  if (stage === null || stage === 'recovering') return WORKFLOW_STEPS.map(() => 'pending');
  const activeIndex =
    stage === 'accepted' || stage === 'planning' ? 0
      : stage === 'hermes' ? 1
        : stage === 'codex' ? 2
          : stage === 'verification' ? 3
            : 4;
  return WORKFLOW_STEPS.map((_, index) => {
    if (index < activeIndex) return 'completed';
    if (index === activeIndex) return 'active';
    return 'pending';
  });
}

type ProjectRun = {
  taskId: string;
  instruction: string;
  priority: LiaProjectTaskPriority;
  createdAt: number;
  stage: ProjectStageKey | null;
  pending: boolean;
  error: string | null;
  receipt: LiaProjectTaskReceipt | null;
  /** Preparado para futura solicitud de información (human-in-the-loop). */
  infoRequest: { prompt: string } | null;
};

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

function formatElapsed(fromMs: number, nowMs: number): string {
  const seconds = Math.max(0, Math.floor((nowMs - fromMs) / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${minutes % 60} min`;
}

function safeTaskDate(fromMs: number): Date | null {
  if (!Number.isFinite(fromMs) || fromMs <= 0) return null;
  const date = new Date(fromMs);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatClock(fromMs: number): string {
  const date = safeTaskDate(fromMs);
  if (!date) return 'Hora no disponible';
  try {
    return new Intl.DateTimeFormat('es-MX', { hour: '2-digit', minute: '2-digit' }).format(date);
  } catch {
    return 'Hora no disponible';
  }
}

function formatDateTimeAttribute(fromMs: number): string | undefined {
  const date = safeTaskDate(fromMs);
  return date ? date.toISOString() : undefined;
}

function ReceiptCard({ receipt }: { receipt: LiaProjectTaskReceipt }) {
  const statusLabel = receipt.status === 'committed'
    ? 'Trabajo terminado'
    : receipt.status === 'verified'
      ? 'Resultado verificado'
      : receipt.status === 'ready_for_review'
        ? 'Listo para revisión'
        : 'Análisis completado';
  const statusEyebrow = receipt.status === 'committed'
    ? 'RESULTADO VERIFICADO'
    : receipt.status === 'verified'
      ? 'VERIFICADO'
      : receipt.status === 'ready_for_review'
        ? 'LISTO PARA REVISIÓN'
        : 'ANÁLISIS COMPLETADO';

  return (
    <div className={`lia-projects-r3-receipt is-${receipt.status}`}>
      <div className="lia-projects-r3-receipt-head">
        <div>
          <span>{statusEyebrow}</span>
          <h3>{statusLabel}</h3>
        </div>
        <span className="lia-projects-r3-receipt-check" aria-hidden="true">✓</span>
      </div>

      <p className="lia-projects-r3-result-text">{receipt.resultText}</p>

      <div className="lia-projects-r3-result-facts">
        {receipt.verification && (
          <div>
            <span>Verificación</span>
            <strong>{receipt.verification.checksPassed}/{receipt.verification.totalChecks}</strong>
            <small>comprobaciones aprobadas</small>
          </div>
        )}

        {receipt.commit && (
          <div>
            <span>Guardado local</span>
            <strong>{receipt.commit.slice(0, 10)}</strong>
            <small>Registro del cambio en el repositorio</small>
          </div>
        )}

        {receipt.status === 'ready_for_review' && (
          <div>
            <span>Estado</span>
            <strong>Revisión</strong>
            <small>El cambio no fue finalizado automáticamente</small>
          </div>
        )}

        {receipt.status === 'analyzed' && (
          <div>
            <span>Verificación</span>
            <strong>No requerida</strong>
            <small>La tarea fue únicamente de análisis</small>
          </div>
        )}
      </div>
    </div>
  );
}

function ConversationTurn({ run, now }: { run: ProjectRun; now: number }) {
  const meta = run.stage ? STAGE_META[run.stage] : null;
  const progress = progressFor(run.stage);
  const live = run.pending;
  const activeStepIndex = progress.indexOf('active');
  const completedCount = progress.filter((state) => state === 'completed').length;
  const progressWidth = Math.round(((completedCount + (activeStepIndex >= 0 ? 1 : 0)) / WORKFLOW_STEPS.length) * 100);

  return (
    <>
      <article className="lia-projects-r3-msg is-user">
        <div className="lia-projects-r3-msg-bubble">
          <p>{run.instruction}</p>
          <footer>
            <span className={`lia-projects-r3-priority-chip is-${run.priority}`}>
              Prioridad {PRIORITY_LABELS[run.priority]}
            </span>
            <time dateTime={formatDateTimeAttribute(run.createdAt)}>{formatClock(run.createdAt)}</time>
          </footer>
        </div>
      </article>

      <article className={`lia-projects-r3-msg is-lia${meta ? ` is-${run.stage}` : ' is-neutral'}`}>
        <div className="lia-projects-r3-lia-avatar" aria-hidden="true">LÍA</div>
        <div className="lia-projects-r3-msg-bubble">
          <header className="lia-projects-r3-msg-head">
            <strong>LÍA</strong>
            {live && meta && (
              <span className="lia-projects-r3-live-chip" role="status">
                <i aria-hidden="true" />
                {run.stage === 'recovering' ? 'Recuperando' : `En curso · hace ${formatElapsed(run.createdAt, now)}`}
              </span>
            )}
          </header>

          {meta && (
            <div className="lia-projects-r3-status-copy">
              <h3>{meta.human}</h3>
              <p>{meta.detail}</p>
            </div>
          )}

          {run.error && <div className="lia-projects-r3-error" role="alert">{run.error}</div>}

          {run.infoRequest && (
            <div className="lia-projects-r3-info-request" role="status">
              <span className="lia-projects-r3-info-request-icon" aria-hidden="true">?</span>
              <div>
                <strong>LÍA necesita un dato</strong>
                <p>{run.infoRequest.prompt}</p>
                <small>Respóndele en el mensaje de abajo.</small>
              </div>
            </div>
          )}

          {!run.receipt && (
            <ol className="lia-projects-r3-stages" aria-label="Progreso del trabajo">
              {WORKFLOW_STEPS.map((base, index) => {
                const step = { ...base, state: progress[index] };
                return (
                  <li
                    key={step.technical}
                    className={`is-${step.state} lia-projects-r3-step-${step.technical}`}
                    aria-current={step.state === 'active' ? 'step' : undefined}
                  >
                    <span className="lia-projects-r3-stage-dot" aria-hidden="true" />
                    <div className="lia-projects-r3-stage-copy">
                      <strong>{step.human}</strong>
                      <small>{step.label}</small>
                    </div>
                  </li>
                );
              })}
            </ol>
          )}

          {live && meta && (
            <div className="lia-projects-r3-progress" aria-hidden="true">
              <span style={{ width: `${progressWidth}%` }} />
            </div>
          )}

          {run.receipt && <ReceiptCard receipt={run.receipt} />}
        </div>
      </article>
    </>
  );
}

export function ProjectsShellR3(props: Props) {
  const [instruction, setInstruction] = useState('');
  const [priority, setPriority] = useState<LiaProjectTaskPriority>('normal');
  const [runs, setRuns] = useState<ProjectRun[]>([]);
  const [activeRun, setActiveRun] = useState<ProjectRun | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const submittingRef = useRef(false);
  const mountedRef = useRef(false);
  const pollRunRef = useRef(0);
  const activeRunRef = useRef<ProjectRun | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const threadRef = useRef<HTMLDivElement | null>(null);
  const sleepRef = useRef<{ run: number; timer: ReturnType<typeof setTimeout>; resolve: () => void } | null>(null);

  const composerBusy = activeRun?.pending === true;

  const cancelSleep = () => {
    const sleep = sleepRef.current;
    if (!sleep) return;
    clearTimeout(sleep.timer);
    sleepRef.current = null;
    sleep.resolve();
  };

  const updateActive = (patch: Partial<ProjectRun>) => {
    const current = activeRunRef.current;
    if (!current) return;
    const next = { ...current, ...patch };
    activeRunRef.current = next;
    setActiveRun(next);
  };

  const setReceipt = (receipt: LiaProjectTaskReceipt | null) => {
    updateActive({ receipt });
  };

  const finishRun = (patch: Partial<ProjectRun>) => {
    const current = activeRunRef.current;
    if (!current) return;
    const done = { ...current, ...patch, pending: false };
    submittingRef.current = false;
    activeRunRef.current = null;
    setActiveRun(null);
    setRuns((previous) => {
      const index = previous.findIndex((run) => run.taskId === done.taskId);
      if (index >= 0) {
        const next = [...previous];
        next[index] = done;
        return next;
      }
      return [...previous, done];
    });
  };

  const beginRun = (task: PersistedProjectTask) => {
    const run: ProjectRun = {
      taskId: task.taskId,
      instruction: task.request.instruction,
      priority: task.request.priority,
      createdAt: task.createdAt,
      stage: 'accepted',
      pending: true,
      error: null,
      receipt: null,
      infoRequest: null,
    };
    activeRunRef.current = run;
    setActiveRun(run);
  };

  const beginRecoveredRun = (task: PersistedProjectTask) => {
    const run: ProjectRun = {
      taskId: task.taskId,
      instruction: task.request.instruction,
      priority: task.request.priority,
      createdAt: task.createdAt,
      stage: 'recovering',
      pending: true,
      error: null,
      receipt: null,
      infoRequest: null,
    };
    activeRunRef.current = run;
    setActiveRun(run);
  };

  const poll = async (task: PersistedProjectTask) => {
    const run = ++pollRunRef.current;
    cancelSleep();
    if (mountedRef.current) updateActive({ pending: true });

    const isCurrent = () => mountedRef.current && pollRunRef.current === run;
    const wait = (delay: number) => new Promise<void>((resolve) => {
      let sleep: { run: number; timer: ReturnType<typeof setTimeout>; resolve: () => void };
      const timer = setTimeout(() => {
        if (sleepRef.current === sleep) sleepRef.current = null;
        resolve();
      }, delay);
      sleep = { run, timer, resolve };
      sleepRef.current = sleep;
    });

    while (isCurrent()) {
      const result = await getProjectTaskStatus(task.taskId);
      if (!isCurrent()) return;
      if (result.kind === 'active') {
        updateActive({ stage: result.status, error: null, pending: true });
        persistProjectTaskStatus(task, result.status);
        await wait(POLL_INTERVAL_MS);
        continue;
      }
      if (result.kind === 'temporary') {
        await wait(TEMPORARY_RETRY_MS);
        continue;
      }
      if (result.kind === 'completed') {
        clearPersistedProjectTask(task.taskId);
        setReceipt(result.receipt);
        finishRun({ stage: 'completed', error: null });
      } else if (result.kind === 'failed') {
        clearPersistedProjectTask(task.taskId);
        finishRun({ stage: 'failed', error: result.message });
      } else if (result.kind === 'unknown') { clearPersistedProjectTask(task.taskId); finishRun({ stage: null, error: 'No se pudo recuperar el estado de esta ejecución. El servicio pudo haberse reiniciado.' }); } else {
        finishRun({ stage: null, error: result.message });
      }
      return;
    }
  };

  useEffect(() => {
    mountedRef.current = true;
    const saved = loadPersistedProjectTask();
    if (saved && saved.lastStatus !== 'completed' && saved.lastStatus !== 'failed') {
      beginRecoveredRun(saved);
      void poll(saved);
    } else if (saved) {
      clearPersistedProjectTask(saved.taskId);
    }
    return () => {
      mountedRef.current = false;
      pollRunRef.current += 1;
      cancelSleep();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!activeRun?.pending) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [activeRun?.pending]);

  useEffect(() => {
    const el = threadRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [runs, activeRun, notice]);

  const resizeComposer = () => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, COMPOSER_MAX_HEIGHT)}px`;
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submittingRef.current || activeRun?.pending) return;
    const cleanInstruction = instruction.trim();
    if (!cleanInstruction) {
      setNotice('Escribe una instrucción concreta para LÍA.');
      return;
    }
    setNotice(null);
    submittingRef.current = true;
    const task = prepareProjectTask({ projectId: PROJECT_ID, instruction: cleanInstruction, priority });
    beginRun(task);
    setInstruction('');
    window.requestAnimationFrame(resizeComposer);
    try {
      const submitted = await submitProjectTask(task);
      if (!mountedRef.current) return;
      if (submitted === 'contract') {
        clearPersistedProjectTask(task.taskId);
        finishRun({ stage: null, error: 'No fue posible aceptar la tarea. Revisa la instrucción e inténtalo de nuevo.' });
        submittingRef.current = false;
        setInstruction(cleanInstruction);
        return;
      }
      if (submitted === 'ambiguous') {
        await submitProjectTask(task); // Same persisted UUID; backend idempotency is authoritative.
        if (!mountedRef.current) return;
      }
      await poll(task);
    } catch {
      submittingRef.current = false;
      if (mountedRef.current) {
        finishRun({ stage: null, error: 'No fue posible preparar o enviar la tarea.' });
        setInstruction(cleanInstruction);
      }
    }
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

  const threadItems = [...runs, ...(activeRun ? [activeRun] : [])];

  const rail = (
    <aside className="lia-dash-r3-rail-shell lia-projects-r3-rail" aria-label="Contexto del proyecto">
      <section>
        <span>PROYECTO ACTIVO</span>
        <strong>LÍA O.S. / Hermes</strong>
        <small>Proyecto conectado al ejecutor local</small>
      </section>
      <section>
        <span>ENTORNO</span>
        <strong>Entorno aislado</strong>
        <small>Cambios verificados y guardado local habilitados</small>
      </section>
    </aside>
  );

  return (
    <ExecutiveShellR3 {...props} activeSection="projects" mainAriaLabel="Proyectos" mainClassName="lia-projects-r3-shell" rail={rail}>
      <header className="lia-projects-r3-title">
        <div>
          <span>PROYECTOS</span>
          <h1>Proyectos</h1>
          <div className="lia-projects-r3-live-badge"><i aria-hidden="true" /> LÍA · Hermes · Codex conectados</div>
          <p>Envía una instrucción y sigue el trabajo de LÍA en vivo</p>
        </div>
      </header>

      <section className="lia-projects-r3-chat" aria-label="Conversación con LÍA">
        <div className="lia-projects-r3-thread" ref={threadRef} role="log" aria-live="polite">
          {threadItems.length === 0 && !notice && (
            <div className="lia-projects-r3-welcome">
              <span className="lia-projects-r3-lia-avatar" aria-hidden="true">LÍA</span>
              <div>
                <span className="lia-projects-r3-welcome-eyebrow">{IDLE_STAGE.eyebrow}</span>
                <strong>{IDLE_STAGE.human}</strong>
                <p>Estoy lista para trabajar en tu proyecto. Escríbeme una instrucción y te iré contando qué estoy haciendo, en qué etapa voy y qué terminé haciendo.</p>
              </div>
            </div>
          )}

          {threadItems.map((run) => (
            <ConversationTurn key={run.taskId} run={run} now={now} />
          ))}

          {notice && (
            <div className="lia-projects-r3-notice" role="status">
              <span aria-hidden="true">!</span>
              <p>{notice}</p>
            </div>
          )}
        </div>

        <form className="lia-projects-r3-composer" onSubmit={submit}>
          <div className="lia-projects-r3-composer-field">
            <button
              type="button"
              className="lia-projects-r3-attach"
              disabled
              aria-label="Adjuntos próximamente"
              title="Adjuntos próximamente"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M21.44 11.05 12.25 20.24a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.82-2.82l8.49-8.48" />
              </svg>
            </button>

            <textarea
              ref={composerRef}
              value={instruction}
              onChange={(event) => handleInstructionChange(event.target.value)}
              onKeyDown={handleComposerKeyDown}
              maxLength={8000}
              rows={1}
              placeholder={composerBusy ? 'LÍA está trabajando… puedes ir preparando tu siguiente instrucción' : 'Escribe una instrucción para LÍA…'}
              aria-label="Escribe una instrucción para LÍA"
            />

            <button
              type="submit"
              className="lia-projects-r3-send"
              disabled={composerBusy || !instruction.trim()}
              aria-label={composerBusy ? 'LÍA está trabajando' : 'Enviar instrucción a LÍA'}
            >
              {composerBusy ? (
                <span className="lia-projects-r3-send-busy" aria-hidden="true" />
              ) : (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M12 19V5" />
                  <path d="m5 12 7-7 7 7" />
                </svg>
              )}
            </button>
          </div>

          <div className="lia-projects-r3-composer-meta">
            <span className="lia-projects-r3-attach-note">Adjuntos próximamente</span>
            <div className="lia-projects-r3-priority" role="group" aria-label="Prioridad de la instrucción">
              {PRIORITY_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={priority === option.value ? 'is-selected' : undefined}
                  aria-pressed={priority === option.value}
                  disabled={composerBusy}
                  onClick={() => setPriority(option.value)}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <span className="lia-projects-r3-composer-hint">Enter envía · Shift+Enter nueva línea</span>
          </div>
        </form>
      </section>
    </ExecutiveShellR3>
  );
}
