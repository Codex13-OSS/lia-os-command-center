import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ExecutiveShellR3 } from '../executive-r3/ExecutiveShellR3';
import {
  type LiaProjectTaskPriority,
} from '../../integrations/liaProjectTaskWorkflowClient';
import { clearPersistedProjectTask, getProjectTaskStatus, loadPersistedProjectTask, persistProjectTaskStatus, prepareProjectTask, submitProjectTask, type LiaProjectTaskReceipt, type LiaProjectTaskStage, type PersistedProjectTask } from '../../integrations/liaProjectTaskClient';
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

type WorkflowStep = {
  label: string;
  description: string;
  state: 'pending' | 'active' | 'completed' | 'failed';
  stateLabel: string;
};

const WORKFLOW_STEPS = [
  { key: 'planning', label: 'Preparando', description: 'Validando tarea y proyecto' },
  { key: 'hermes', label: 'Hermes', description: 'Analizando y organizando el trabajo' },
  { key: 'codex', label: 'Ejecutando', description: 'Aplicando cambios en entorno aislado' },
  { key: 'verification', label: 'Verificando', description: 'Comprobando el resultado' },
  { key: 'commit', label: 'Guardando', description: 'Creando commit local verificado' },
] as const;

function getWorkflowSteps(stage: LiaProjectTaskStage | 'recovering' | null): WorkflowStep[] {
  if (stage === 'failed') {
    return WORKFLOW_STEPS.map((step) => ({
      label: step.label,
      description: step.description,
      state: 'failed',
      stateLabel: 'No completado',
    }));
  }

  if (stage === null || stage === 'recovering') {
    return WORKFLOW_STEPS.map((step) => ({
      label: step.label,
      description: step.description,
      state: 'pending',
      stateLabel: 'Pendiente',
    }));
  }

  if (stage === 'completed') {
    return WORKFLOW_STEPS.map((step) => ({
      label: step.label,
      description: step.description,
      state: 'completed',
      stateLabel: 'Completado',
    }));
  }

  const activeIndex =
    stage === 'accepted' || stage === 'planning' ? 0
      : stage === 'hermes' ? 1
        : stage === 'codex' ? 2
          : stage === 'verification' ? 3
            : 4;

  return WORKFLOW_STEPS.map((step, index) => {
    if (index < activeIndex) {
      return {
        label: step.label,
        description: step.description,
        state: 'completed',
        stateLabel: 'Completado',
      };
    }

    if (index === activeIndex) {
      return {
        label: step.label,
        description: step.description,
        state: 'active',
        stateLabel: 'En curso',
      };
    }

    return {
      label: step.label,
      description: step.description,
      state: 'pending',
      stateLabel: 'Pendiente',
    };
  });
}

function workflowHeadline(stage: LiaProjectTaskStage | 'recovering' | null): {
  eyebrow: string;
  title: string;
  description: string;
} {
  if (stage === 'recovering') {
    return {
      eyebrow: 'RECUPERANDO TAREA',
      title: 'Consultando la ejecución durable',
      description: 'LÍA está recuperando el último estado confirmado de la tarea.',
    };
  }

  if (stage === null) {
    return {
      eyebrow: 'LÍA ESTÁ LISTA',
      title: 'Describe qué quieres lograr',
      description: 'La ejecución aparecerá aquí usando únicamente estados reales del backend.',
    };
  }

  if (stage === 'accepted' || stage === 'planning') {
    return {
      eyebrow: 'PREPARANDO',
      title: 'Preparando la tarea',
      description: 'LÍA está validando la instrucción y el proyecto.',
    };
  }

  if (stage === 'hermes') {
    return {
      eyebrow: 'HERMES',
      title: 'Analizando la instrucción',
      description: 'Hermes está definiendo el plan mínimo necesario para completar la tarea.',
    };
  }

  if (stage === 'codex') {
    return {
      eyebrow: 'EJECUTANDO',
      title: 'Aplicando el cambio',
      description: 'Codex está trabajando dentro de un entorno aislado.',
    };
  }

  if (stage === 'verification') {
    return {
      eyebrow: 'VERIFICANDO',
      title: 'Comprobando el resultado',
      description: 'LÍA está ejecutando las verificaciones autorizadas.',
    };
  }

  if (stage === 'commit') {
    return {
      eyebrow: 'GUARDANDO',
      title: 'Guardando resultado verificado',
      description: 'LÍA está creando el commit local después de la verificación.',
    };
  }

  if (stage === 'completed') {
    return {
      eyebrow: 'COMPLETADO',
      title: 'Resultado terminado',
      description: 'La tarea terminó y el resultado final ya está disponible.',
    };
  }

  return {
    eyebrow: 'NO COMPLETADO',
    title: 'La tarea no pudo completarse',
    description: 'Consulta el diagnóstico seguro mostrado abajo.',
  };
}
export function ProjectsShellR3(props: Props) {
  const [instruction, setInstruction] = useState('');
  const [priority, setPriority] = useState<LiaProjectTaskPriority>('normal');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<LiaProjectTaskReceipt | null>(null);
  const [stage, setStage] = useState<LiaProjectTaskStage | 'recovering' | null>(null);
  const submittingRef = useRef(false);
  const mountedRef = useRef(false);
  const pollRunRef = useRef(0);
  const sleepRef = useRef<{ run: number; timer: ReturnType<typeof setTimeout>; resolve: () => void } | null>(null);
  const workflowSteps = getWorkflowSteps(stage);
  const workflowStatus = workflowHeadline(stage);

  const cancelSleep = () => {
    const sleep = sleepRef.current;
    if (!sleep) return;
    clearTimeout(sleep.timer);
    sleepRef.current = null;
    sleep.resolve();
  };

  const poll = async (task: PersistedProjectTask) => {
    const run = ++pollRunRef.current;
    cancelSleep();
    if (mountedRef.current) setPending(true);

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
        setStage(result.status);
        setError(null);
        persistProjectTaskStatus(task, result.status);
        await wait(POLL_INTERVAL_MS);
        continue;
      }
      if (result.kind === 'temporary') {
        // Keep the last authoritative stage and retry until the task becomes
        // terminal or this cancelable polling run is superseded/unmounted.
        await wait(TEMPORARY_RETRY_MS);
        continue;
      }
      setPending(false); submittingRef.current = false;
      if (result.kind === 'completed') { clearPersistedProjectTask(task.taskId); setStage('completed'); setReceipt(result.receipt); setError(null); }
      else if (result.kind === 'failed') { clearPersistedProjectTask(task.taskId); setStage('failed'); setError(result.message); }
      else if (result.kind === 'unknown') { clearPersistedProjectTask(task.taskId); setStage(null); setError('No se pudo recuperar el estado de esta ejecución. El servicio pudo haberse reiniciado.'); }
      else setError(result.message);
      return;
    }
  };

  useEffect(() => {
    mountedRef.current = true;
    const saved = loadPersistedProjectTask();
    if (saved && saved.lastStatus !== 'completed' && saved.lastStatus !== 'failed') { setStage('recovering'); void poll(saved); }
    else if (saved) clearPersistedProjectTask(saved.taskId);
    return () => {
      mountedRef.current = false;
      pollRunRef.current += 1;
      cancelSleep();
    };
  }, []);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submittingRef.current) return;
    const cleanInstruction = instruction.trim();
    if (!cleanInstruction) {
      setError('Escribe una instrucción concreta para LÍA.');
      return;
    }

    submittingRef.current = true;
    setPending(true);
    setError(null);
    setReceipt(null);
    try {
      const task = prepareProjectTask({ projectId: PROJECT_ID, instruction: cleanInstruction, priority });
      setStage('accepted');
      const submitted = await submitProjectTask(task);
      if (!mountedRef.current) return;
      if (submitted === 'contract') { clearPersistedProjectTask(task.taskId); setError('No fue posible aceptar la tarea.'); submittingRef.current = false; setPending(false); return; }
      if (submitted === 'ambiguous') {
        await submitProjectTask(task); // Same persisted UUID; backend idempotency is authoritative.
        if (!mountedRef.current) return;
      }
      await poll(task);
    } catch {
      submittingRef.current = false;
      if (mountedRef.current) { setPending(false); setError('No fue posible preparar o enviar la tarea.'); }
    }
  };

  const rail = (
    <aside className="lia-dash-r3-rail-shell lia-projects-r3-rail" aria-label="Contexto del proyecto">
      <section>
        <span>PROYECTO ACTIVO</span>
        <strong>LÍA O.S. / Hermes</strong>
        <small>Orquestación Hermes · ejecución Codex</small>
      </section>
      <section>
        <span>ENTORNO</span>
        <strong>Worktree aislado</strong>
        <small>Pruebas y commit local habilitados</small>
      </section>
    </aside>
  );

  return (
    <ExecutiveShellR3 {...props} activeSection="projects" mainAriaLabel="Proyectos" mainClassName="lia-projects-r3-shell" rail={rail}>
      <header className="lia-projects-r3-title">
        <div>
          <span>PROYECTOS</span><h1>Proyectos</h1>
          <div className="lia-projects-r3-connected-badge">LÍA · Hermes · Codex conectados</div>
          <p>Ejecución real y aislada con LÍA</p>
        </div>
      </header>

      <section className="lia-projects-r3-project-card">
        <div className="lia-projects-r3-project-head">
          <div className="lia-projects-r3-project-mark">LÍA</div>
          <div><span>lia-hermes</span><h2>LÍA O.S. / Hermes</h2><p>Proyecto operativo conectado al ejecutor local</p></div>
          <i>Activo</i>
        </div>

        <form onSubmit={submit} className="lia-projects-r3-form">
          <label htmlFor="lia-project-instruction">Nueva tarea</label>
          <textarea
            id="lia-project-instruction"
            value={instruction}
            onChange={(event) => setInstruction(event.target.value)}
            disabled={pending}
            maxLength={8000}
            rows={6}
            placeholder="Describe el cambio que LÍA debe analizar, ejecutar y verificar…"
          />
          <div className="lia-projects-r3-form-actions">
            <label htmlFor="lia-project-priority">Prioridad
              <select id="lia-project-priority" value={priority} disabled={pending} onChange={(event) => setPriority(event.target.value as LiaProjectTaskPriority)}>
                <option value="low">Baja</option><option value="normal">Normal</option><option value="high">Alta</option><option value="critical">Crítica</option>
              </select>
            </label>
            <button type="submit" disabled={pending || !instruction.trim()}>{pending ? 'Ejecución en curso…' : 'Ejecutar con LÍA'}</button>
          </div>
        </form>

        <section className={`lia-projects-r3-workflow${stage && stage !== 'completed' && stage !== 'failed' ? ' is-running' : ''}`} aria-labelledby="lia-projects-workflow-title" aria-live="polite">
          <div className="lia-projects-r3-workflow-head">
            <div>
              <span>{workflowStatus.eyebrow}</span>
              <h3 id="lia-projects-workflow-title">{workflowStatus.title}</h3>
              <p>{workflowStatus.description}</p>
            </div>
            {pending && stage !== 'recovering' && (
              <div className="lia-projects-r3-live-indicator" aria-label="Ejecución activa">
                <i aria-hidden="true" />
                <span>En vivo</span>
              </div>
            )}
          </div>

          <ol className="lia-projects-r3-stages">
            {workflowSteps.map((step, index) => (
              <li
                key={step.label}
                className={`is-${step.state}`}
                aria-current={step.state === 'active' ? 'step' : undefined}
                aria-label={`${step.label}: ${step.stateLabel}`}
              >
                <div className="lia-projects-r3-stage-marker">
                  <i aria-hidden="true" />
                  <b>{index + 1}</b>
                </div>
                <div className="lia-projects-r3-stage-copy">
                  <strong>{step.label}</strong>
                  <small>{step.description}</small>
                  <em>{step.stateLabel}</em>
                </div>
              </li>
            ))}
          </ol>
        </section>

        {error && <div className="lia-projects-r3-error" role="alert">{error}</div>}
        {receipt && (
          <article className={`lia-projects-r3-receipt is-${receipt.status}`} aria-label="Resultado de la ejecución">
            <div className="lia-projects-r3-receipt-head">
              <div>
                <span>
                  {receipt.status === 'committed'
                    ? 'RESULTADO VERIFICADO'
                    : receipt.status === 'verified'
                      ? 'VERIFICADO'
                      : receipt.status === 'ready_for_review'
                        ? 'LISTO PARA REVISIÓN'
                        : 'ANÁLISIS COMPLETADO'}
                </span>
                <h3>
                  {receipt.status === 'committed'
                    ? 'Tarea completada'
                    : receipt.status === 'verified'
                      ? 'Resultado verificado'
                      : receipt.status === 'ready_for_review'
                        ? 'Listo para revisión'
                        : 'Análisis completado'}
                </h3>
              </div>
              <i aria-hidden="true">✓</i>
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
                  <span>Commit local</span>
                  <strong>{receipt.commit.slice(0, 10)}</strong>
                  <small>Cambio guardado localmente</small>
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
          </article>
        )}
      </section>
    </ExecutiveShellR3>
  );
}
