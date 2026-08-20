import { useMemo, useState } from 'react';
import { ExecutiveShellR3 } from '../executive-r3/ExecutiveShellR3';
import { type LiaOfficeAgent, type LiaOfficeState } from '../../integrations/liaOfficeClient';
import type { LiaConversationController } from '../lia-r3/liaConversationController';
import '../../styles/officeExecutiveR3.css';
import { useLiaCoreState } from '../lia-core-r3/useLiaCoreState';
import { LiaVoiceSurfaceR3 } from '../lia-r3/LiaVoiceSurfaceR3';

type Props = {
  onDashboard: () => void; onAgenda: () => void; onProjects: () => void; onAgents: () => void; onServers: () => void;
  onSettings: () => void;
  onTracking: () => void; onDocuments: () => void; onAlerts: () => void; onLogout: () => void;
  conversationController?: LiaConversationController;
};
const LABELS: Record<LiaOfficeState, string> = {
  idle: 'En espera', queued: 'En cola', planned: 'Planificado', planning: 'Planificando', delegating: 'Enrutando plan',
  implementing: 'Implementando', verifying: 'Verificando', reviewing: 'Revisando', correcting: 'Corrigiendo',
  waiting_human: 'Espera humana', completed: 'Cerrado', failed: 'Fallido',
};


function formatTime(value?: number): string {
  if (value === undefined) return 'Sin cambio registrado';
  try { return new Intl.DateTimeFormat('es-MX', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(value)); }
  catch { return 'Fecha no disponible'; }
}

function Character({ agent, selected, onSelect }: { agent: LiaOfficeAgent; selected: boolean; onSelect: () => void }) {
  return (
    <button type="button" className={`lia-office-r3-agent is-${agent.id} is-${agent.state}${selected ? ' is-selected' : ''}`} onClick={onSelect} aria-pressed={selected} aria-label={`${agent.name}, ${LABELS[agent.state]}`}>
      <span className="lia-office-r3-state"><i aria-hidden="true" />{LABELS[agent.state]}</span>
      <span className="lia-office-r3-person" aria-hidden="true"><i className="head" /><i className="body" /><i className="arms" /><i className="shadow" /></span>
      <strong>{agent.name}</strong><small>{agent.role}</small>
    </button>
  );
}

function Inspector({ agent, onClose }: { agent: LiaOfficeAgent; onClose: () => void }) {
  return <aside className="lia-office-r3-inspector" aria-label="Inspector del agente" aria-live="polite">
    <header><span>INSPECTOR DE AGENTE</span><b className={`is-${agent.state}`}>{LABELS[agent.state]}</b><button type="button" onClick={onClose} aria-label="Cerrar inspector">×</button></header>
    <div className="lia-office-r3-inspector-id"><i aria-hidden="true">{agent.name.slice(0, 2).toUpperCase()}</i><div><strong>{agent.name}</strong><small>{agent.role} · {agent.station}</small></div></div>
    <dl>
      <div><dt>Goal</dt><dd>{agent.goal ?? 'Sin Goal asignado'}</dd></div>
      <div><dt>Task</dt><dd>{agent.taskId ?? 'Sin task durable'}</dd></div>
      <div><dt>Intento</dt><dd>{agent.attempt ?? '—'}</dd></div>
      <div><dt>Etapa</dt><dd>{agent.stage ?? 'idle'}</dd></div>
      <div><dt>Dependencias</dt><dd>{agent.dependencies.length ? agent.dependencies.join(', ') : 'Ninguna registrada'}</dd></div>
      <div><dt>Evidencia</dt><dd>{agent.verification ?? (agent.evidenceKind === 'validated_plan_metadata' ? 'Metadata de plan validado; no prueba ejecución leaf.' : 'Sin verification disponible')}</dd></div>
      <div><dt>Bloqueo</dt><dd>{agent.blockingReason ?? 'Sin bloqueo registrado'}</dd></div>
      <div><dt>Último cambio</dt><dd>{formatTime(agent.lastChangedAt)}</dd></div>
    </dl>
  </aside>;
}

export function OfficeShellR3(props: Props) {
  const { office, loaded } = useLiaCoreState();
  const [selectedId, setSelectedId] = useState<LiaOfficeAgent['id'] | null>(null);
  const selected = useMemo(() => office?.agents.find((agent) => agent.id === selectedId) ?? office?.agents[0], [office, selectedId]);
  const agent = (id: LiaOfficeAgent['id']) => office?.agents.find((item) => item.id === id);
  return <ExecutiveShellR3 {...props} activeSection="agents" mainAriaLabel="LÍA Agent Office" mainClassName="lia-office-r3-shell" rail={null}>
    <header className="lia-office-r3-title">
      <div><span>AGENT OFFICE / EVIDENCIA DURABLE</span><h1>La oficina de LÍA</h1><p>Una vista operativa. Cada estado proviene de Goals, tareas, Supervisor o Board reales.</p></div>
      <div className="lia-office-r3-title-actions"><LiaVoiceSurfaceR3 controller={props.conversationController} compact /><div className="lia-office-r3-live"><i aria-hidden="true" /><span>Supervisor</span><strong>{office?.supervisor.state ?? (loaded ? 'no disponible' : 'conectando')}</strong><small>{office ? `${office.capacity.inFlight} / ${office.capacity.ceiling} slots en uso` : 'Leyendo estado'}</small></div></div>
    </header>

    {!loaded && <div className="lia-office-r3-empty" role="status"><i aria-hidden="true" /><strong>Abriendo la oficina…</strong><span>Consultando evidencia durable.</span></div>}
    {loaded && !office && <div className="lia-office-r3-empty is-error" role="status"><strong>La oficina no está disponible</strong><span>No se muestra actividad sin evidencia del backend.</span></div>}
    {office && <div className="lia-office-r3-content">
      <section className="lia-office-r3-world" aria-label="Plano 2.5D de la oficina">
        <div className="lia-office-r3-world-head">
          <div><span>PLANTA OPERATIVA</span><strong>{office.focus?.title ?? 'Sin Goal activo'}</strong></div>
          <div className="lia-office-r3-chips"><b>{office.focus?.executionMode ? `Modo ${office.focus.executionMode}` : 'Sin propuesta validada'}</b><b>{office.focus ? LABELS[office.focus.officeState] : 'Oficina en espera'}</b></div>
        </div>
        <div className="lia-office-r3-floor">
          <div className="lia-office-r3-grid" aria-hidden="true" />
          <div className="lia-office-r3-walls" aria-hidden="true"><i /><i /></div>
          {office.connections.length > 0 && <svg className="lia-office-r3-connections" viewBox="0 0 1000 500" preserveAspectRatio="none" aria-label="Dependencias planificadas registradas">
            {office.connections.map((connection, index) => {
              const y = 170 + (index % 4) * 48;
              return <path key={`${connection.from}-${connection.to}-${index}`} d={`M ${170 + (index % 2) * 70} ${y} C 390 ${y - 55}, 610 ${y + 55}, ${830 - (index % 2) * 70} ${y}`} data-kind={connection.kind} />;
            })}
          </svg>}
          <div className="lia-office-r3-zone is-hub"><span>ESTACIÓN CENTRAL · HERMES</span><div className="lia-office-r3-console" aria-hidden="true"><i /><i /><i /></div>{agent('hermes') && <Character agent={agent('hermes')!} selected={selectedId === 'hermes'} onSelect={() => setSelectedId('hermes')} />}</div>
          <div className="lia-office-r3-zone is-architecture"><span>ARQUITECTURA</span><div className="lia-office-r3-desk" aria-hidden="true"><i /></div>{agent('architecture') && <Character agent={agent('architecture')!} selected={selectedId === 'architecture'} onSelect={() => setSelectedId('architecture')} />}</div>
          <div className="lia-office-r3-zone is-implementation"><span>IMPLEMENTACIÓN</span><div className="lia-office-r3-desk" aria-hidden="true"><i /></div>{agent('implementation') && <Character agent={agent('implementation')!} selected={selectedId === 'implementation'} onSelect={() => setSelectedId('implementation')} />}</div>
          <div className="lia-office-r3-zone is-verification"><span>QA / VERIFICATION</span><div className="lia-office-r3-desk" aria-hidden="true"><i /></div>{agent('verification') && <Character agent={agent('verification')!} selected={selectedId === 'verification'} onSelect={() => setSelectedId('verification')} />}</div>
          <div className="lia-office-r3-zone is-risk"><span>DATA / RISK</span><div className="lia-office-r3-desk" aria-hidden="true"><i /></div>{agent('data-risk') && <Character agent={agent('data-risk')!} selected={selectedId === 'data-risk'} onSelect={() => setSelectedId('data-risk')} />}</div>
          <div className="lia-office-r3-waiting"><span>LOUNGE / IDLE</span><i aria-hidden="true" /><i aria-hidden="true" /></div>
          <section className="lia-office-r3-boardroom" aria-label="Sala del Executive Board">
            <header><span>EXECUTIVE BOARD</span><small>{office.board.decisions.length ? `${office.board.decisions.length} decisiones registradas` : 'Sin sesión registrada'}</small></header>
            <div className="lia-office-r3-board-table" aria-hidden="true" />
            <div className="lia-office-r3-board-seats">
              {office.board.rolesPresent.length ? office.board.rolesPresent.map((role) => <span key={role}><i aria-hidden="true" />{role}</span>) : <em>Sala disponible</em>}
            </div>
          </section>
        </div>
      </section>

      <section className="lia-office-r3-evidence" aria-label="Evidencia de operación">
        <article><header><span>GOAL / TASK</span><b>{office.focus?.currentTask?.taskId ?? '—'}</b></header>{office.focus ? <><strong>{office.focus.title}</strong><div><span>Intento {office.focus.currentTask?.attemptNumber ?? '—'}</span><span>Profundidad {office.focus.currentTask?.continuationDepth ?? '—'}</span><span>{office.focus.currentTask?.status ?? office.focus.goalStatus}</span></div><small>{office.focus.currentTask?.completedStages.length ? `Etapas confirmadas: ${office.focus.currentTask.completedStages.join(' · ')}` : 'Sin etapas completadas confirmadas'}</small></> : <p>La oficina está honestamente vacía: no hay Goals durables.</p>}</article>
        <article><header><span>DAG VALIDADO</span><b>{office.focus?.executionMode ?? 'sin snapshot'}</b></header>{office.focus?.planSteps.length ? <ol>{office.focus.planSteps.map((step) => <li key={step.id}><i className={`is-${step.state}`} aria-hidden="true" /><div><strong>{step.title}</strong><small>{step.role} · {step.state}{step.dependsOn.length ? ` · depende de ${step.dependsOn.join(', ')}` : ''}</small></div></li>)}</ol> : <p>No hay metadata durable de plan. Ningún leaf se representa ejecutando.</p>}</article>
        <article><header><span>BOUNDARY LEAF</span><b>NO INSTRUMENTADO</b></header><p>Hermes no expone eventos leaf fiables. La oficina usa etapas durables y roles planificados, sin convertir metadata en ejecución.</p><small>Contrato futuro: leaf.started / leaf.stage_changed / leaf.finished, con taskId, stepId, role, state y occurredAt; sin prompts, comandos, paths ni output crudo.</small></article>
      </section>
    </div>}
    {selectedId && selected && <div className="lia-office-r3-inspector-layer" role="presentation" onClick={() => setSelectedId(null)}>
      <div onClick={(event) => event.stopPropagation()}><Inspector agent={selected} onClose={() => setSelectedId(null)} /></div>
    </div>}
  </ExecutiveShellR3>;
}
