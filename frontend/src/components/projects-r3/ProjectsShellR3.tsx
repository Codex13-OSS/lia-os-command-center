import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ExecutiveShellR3 } from '../executive-r3/ExecutiveShellR3';
import {
  type LiaProjectTaskPriority,
} from '../../integrations/liaProjectTaskWorkflowClient';
import { getProjectTaskStatus, loadPersistedProjectTask, persistProjectTaskStatus, prepareProjectTask, submitProjectTask, type LiaProjectTaskReceipt, type LiaProjectTaskStage, type PersistedProjectTask } from '../../integrations/liaProjectTaskClient';
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

export function ProjectsShellR3(props: Props) {
  const [instruction, setInstruction] = useState('');
  const [priority, setPriority] = useState<LiaProjectTaskPriority>('normal');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<LiaProjectTaskReceipt | null>(null);
  const [stage, setStage] = useState<LiaProjectTaskStage | 'recovering' | null>(null);
  const submittingRef = useRef(false);

  const poll = async (task: PersistedProjectTask) => {
    setPending(true);
    while (true) {
      const result = await getProjectTaskStatus(task.taskId);
      if (result.kind === 'active') { setStage(result.status); persistProjectTaskStatus(task, result.status); await new Promise((resolve) => setTimeout(resolve, 1500)); continue; }
      if (result.kind === 'temporary') { setError('El estado no está disponible temporalmente. La ejecución puede seguir en curso.'); await new Promise((resolve) => setTimeout(resolve, 2500)); continue; }
      setPending(false); submittingRef.current = false;
      if (result.kind === 'completed') { setStage('completed'); setReceipt(result.receipt); setError(null); }
      else if (result.kind === 'failed') { setStage('failed'); setError(result.message); }
      else if (result.kind === 'unknown') { setStage(null); setError('No se pudo recuperar el estado de esta ejecución. El servicio pudo haberse reiniciado.'); }
      else setError(result.message);
      return;
    }
  };

  useEffect(() => { const saved = loadPersistedProjectTask(); if (saved) { setStage('recovering'); void poll(saved); } }, []);

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
      if (submitted === 'contract') { setError('No fue posible aceptar la tarea.'); submittingRef.current = false; setPending(false); return; }
      if (submitted === 'ambiguous') await submitProjectTask(task); // Same persisted UUID; backend idempotency is authoritative.
      await poll(task);
    } catch { submittingRef.current = false; setPending(false); setError('No fue posible iniciar la recuperación de la tarea.'); }
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
        <div><span>PROYECTOS</span><h1>Proyectos</h1><p>Ejecución real y aislada con LÍA</p></div>
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

        <ol className={`lia-projects-r3-stages${pending ? ' is-running' : ''}${receipt ? ' is-complete' : ''}`} aria-label="Flujo de ejecución" aria-live="polite">
          <li><i />{stage === 'recovering' ? 'Recuperando estado…' : stage ? `Estado: ${stage}` : 'Esperando ejecución'}</li>
        </ol>

        {error && <div className="lia-projects-r3-error" role="alert">{error}</div>}
        {receipt && (
          <article className="lia-projects-r3-receipt" aria-label="Resultado de la ejecución">
            <h3>Resultado verificado</h3>
            <dl>
              <div><dt>Status</dt><dd>{receipt.status}</dd></div>
              <div><dt>Execution ID</dt><dd>{receipt.executionId}</dd></div>
              {receipt.commit && <div><dt>Commit</dt><dd>{receipt.commit}</dd></div>}
              {receipt.verification && <div><dt>Verificación</dt><dd>{receipt.verification.checksPassed}/{receipt.verification.totalChecks} verificaciones aprobadas</dd></div>}
            </dl>
          </article>
        )}
      </section>
    </ExecutiveShellR3>
  );
}
