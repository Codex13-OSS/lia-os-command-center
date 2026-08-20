import { useEffect, useState } from 'react';
import { ExecutiveShellR3 } from '../executive-r3/ExecutiveShellR3';
import type { LiaConversationController } from '../lia-r3/liaConversationController';
import { LiaVoiceSurfaceR3 } from '../lia-r3/LiaVoiceSurfaceR3';
import '../../styles/serversExecutiveR3.css';
import { readLiaServerTelemetry, type LiaServerTelemetry } from '../../integrations/liaServerTelemetryClient';
import { readLiaServerInventory, type LiaServerInventory } from '../../integrations/liaServerInventoryClient';

type Props = {
  onDashboard: () => void;
  onAgenda: () => void;
  onProjects: () => void;
  onAgents: () => void;
  onServers: () => void;
  onSettings: () => void;
  onTracking: () => void;
  onDocuments: () => void;
  onAlerts: () => void;
  onLogout: () => void;
  conversationController?: LiaConversationController;
};

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '—';
  const gb = value / 1024 / 1024 / 1024;
  return `${gb.toFixed(gb >= 100 ? 0 : 1)} GB`;
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function Metric({
  label,
  value,
  detail,
  percent,
}: {
  label: string;
  value: string;
  detail: string;
  percent?: number;
}) {
  return (
    <article className="lia-servers-r3-metric">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
      {percent !== undefined && (
        <div className="lia-servers-r3-meter" aria-label={`${label} ${percent}%`}>
          <i style={{ width: `${Math.max(0, Math.min(100, percent))}%` }} />
        </div>
      )}
    </article>
  );
}

export function ServersShellR3(props: Props) {
  const [telemetry, setTelemetry] = useState<LiaServerTelemetry | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [inventory, setInventory] = useState<LiaServerInventory | null>(null);
  const [inventoryLoaded, setInventoryLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const refresh = async () => {
      const next = await readLiaServerTelemetry();
      if (!cancelled) {
        setTelemetry(next);
        setLoaded(true);
      }
    };

    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 5000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    const refreshInventory = async () => {
      const next = await readLiaServerInventory();
      if (!cancelled) {
        setInventory(next);
        setInventoryLoaded(true);
      }
    };

    void refreshInventory();
    const timer = window.setInterval(() => { void refreshInventory(); }, 15000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  return (
    <ExecutiveShellR3
      {...props}
      activeSection="servers"
      mainAriaLabel="Centro de servidores"
      mainClassName="lia-servers-r3-shell"
      rail={null}
    >
      <header className="lia-servers-r3-title">
        <div>
          <span>INFRAESTRUCTURA / READ-ONLY</span>
          <h1>Servidores</h1>
          <p>Observabilidad y administración protegida de infraestructura.</p>
        </div>

        <div className="lia-servers-r3-title-actions">
          <LiaVoiceSurfaceR3 controller={props.conversationController} compact />
          <div className="lia-servers-r3-mode">
            <i />
            <span>MODO</span>
            <strong>{telemetry ? 'En línea · solo lectura' : loaded ? 'Sin lectura' : 'Conectando…'}</strong>
            <small>Acciones reales bloqueadas</small>
          </div>
        </div>
      </header>

      <section className="lia-servers-r3-overview">
        <article className="lia-servers-r3-node">
          <header>
            <div>
              <span>NODO PRINCIPAL</span>
              <h2>Contabo</h2>
            </div>
            <b className={telemetry ? 'is-online' : 'is-pending'}>
              {telemetry ? 'EN LÍNEA' : loaded ? 'SIN LECTURA' : 'CONECTANDO'}
            </b>
          </header>

          <div className="lia-servers-r3-node-map" aria-hidden="true">
            <div className="lia-servers-r3-rack">
              <i /><i /><i /><i />
            </div>
            <div className="lia-servers-r3-pulse" />
          </div>

          <footer>
            <div><span>Estado</span><strong>{telemetry ? 'Operativo' : 'No disponible'}</strong></div>
            <div><span>Hostname</span><strong>{telemetry?.node.hostname ?? '—'}</strong></div>
            <div><span>Última lectura</span><strong>{telemetry ? new Date(telemetry.generatedAt).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—'}</strong></div>
          </footer>
        </article>

        <section className="lia-servers-r3-health" aria-label="Salud del servidor">
          <header>
            <span>TELEMETRÍA DEL SISTEMA</span>
            <small>Lecturas reales cuando se conecte el adapter</small>
          </header>

          <div className="lia-servers-r3-metrics">
            <Metric
              label="CPU"
              value={telemetry ? `${telemetry.cpu.percent.toFixed(1)}%` : '—'}
              detail={telemetry ? `${telemetry.cpu.cores} cores` : 'Sin lectura'}
              percent={telemetry?.cpu.percent}
            />
            <Metric
              label="RAM"
              value={telemetry ? `${telemetry.memory.percent.toFixed(1)}%` : '—'}
              detail={telemetry ? `${formatBytes(telemetry.memory.usedBytes)} / ${formatBytes(telemetry.memory.totalBytes)}` : 'Sin lectura'}
              percent={telemetry?.memory.percent}
            />
            <Metric
              label="Disco"
              value={telemetry ? `${telemetry.disk.percent.toFixed(1)}%` : '—'}
              detail={telemetry ? `${formatBytes(telemetry.disk.usedBytes)} / ${formatBytes(telemetry.disk.totalBytes)}` : 'Sin lectura'}
              percent={telemetry?.disk.percent}
            />
            <Metric
              label="Load"
              value={telemetry ? telemetry.cpu.load1.toFixed(2) : '—'}
              detail={telemetry ? `${telemetry.cpu.load5.toFixed(2)} · ${telemetry.cpu.load15.toFixed(2)}` : '1 / 5 / 15 min'}
            />
            <Metric
              label="Uptime"
              value={telemetry ? formatUptime(telemetry.uptimeSeconds) : '—'}
              detail={telemetry ? `${telemetry.node.platform} · ${telemetry.node.architecture}` : 'Sin lectura'}
            />
            <Metric
              label="Hardware"
              value={telemetry ? `${telemetry.cpu.cores} vCPU` : '—'}
              detail={telemetry?.cpu.model ?? 'Sin lectura'}
            />
          </div>
        </section>
      </section>

      <section className="lia-servers-r3-grid">
        <article className="lia-servers-r3-card">
          <header>
            <span>APLICACIONES / PM2</span>
            <b>{inventory ? `${inventory.pm2.length} PROCESOS` : inventoryLoaded ? 'NO DISPONIBLE' : 'LEYENDO'}</b>
          </header>

          <div className="lia-servers-r3-services">
            {(inventory?.pm2 ?? []).slice(0, 14).map((process) => (
              <div key={process.name}>
                <i className={process.status === 'online' ? 'is-online' : ''} />
                <span>
                  <strong>{process.name}</strong>
                  <small>PID {process.pid || '—'} · {(process.memoryBytes / 1024 / 1024).toFixed(0)} MB</small>
                </span>
                <b>{process.status}</b>
              </div>
            ))}

            {inventoryLoaded && inventory?.pm2.length === 0 && (
              <div className="lia-servers-r3-inline-empty">Sin procesos PM2 visibles.</div>
            )}
          </div>
        </article>

        <article className="lia-servers-r3-card">
          <header>
            <span>SERVICIOS DEL SISTEMA</span>
            <b>{inventory ? `${inventory.systemServices.length} ACTIVOS` : '—'}</b>
          </header>

          <div className="lia-servers-r3-service-chips">
            {(inventory?.systemServices ?? []).map((service) => (
              <span key={service}>
                <i />
                {service.replace(/\.service$/, '')}
              </span>
            ))}
          </div>
        </article>

        <article className="lia-servers-r3-card">
          <header>
            <span>DOCKER</span>
            <b>{inventory ? `${inventory.containers.length} CONTENEDORES` : '—'}</b>
          </header>

          <div className="lia-servers-r3-containers">
            {(inventory?.containers ?? []).map((container) => (
              <div key={container.name}>
                <div className="lia-servers-r3-container-icon" aria-hidden="true">
                  <i /><i /><i />
                </div>
                <span>
                  <strong>{container.name}</strong>
                  <small>{container.image}</small>
                </span>
                <b>{container.status}</b>
              </div>
            ))}

            {inventoryLoaded && inventory?.containers.length === 0 && (
              <div className="lia-servers-r3-inline-empty">Sin contenedores visibles.</div>
            )}
          </div>
        </article>

        <article className="lia-servers-r3-card">
          <header>
            <span>PUERTOS EN ESCUCHA</span>
            <b>{inventory ? `${inventory.ports.length} DETECTADOS` : '—'}</b>
          </header>

          <div className="lia-servers-r3-ports">
            {(inventory?.ports ?? []).map((port) => (
              <span key={port}>{port}</span>
            ))}
          </div>
        </article>
      </section>

      <section className="lia-servers-r3-explorer">
        <header>
          <div>
            <span>MAPA DEL SERVIDOR</span>
            <h2>Contenido de Contabo</h2>
            <p>Vista segura de primer nivel. Ningún archivo puede abrirse, editarse o eliminarse desde esta versión.</p>
          </div>
          <b>{inventory?.capabilities.filesystem ? 'READ-ONLY' : 'SIN LECTURA'}</b>
        </header>

        <div className="lia-servers-r3-root-grid">
          {(inventory?.roots ?? []).map((root) => (
            <article key={root.path} className="lia-servers-r3-root">
              <header>
                <i aria-hidden="true" />
                <div>
                  <span>DIRECTORIO</span>
                  <strong>{root.path}</strong>
                </div>
                <b>{root.entries.length}</b>
              </header>

              <div className="lia-servers-r3-tree">
                {root.entries.map((entry) => (
                  <div key={`${root.path}/${entry.name}`}>
                    <i className={`is-${entry.type}`} aria-hidden="true" />
                    <span>{entry.name}</span>
                    <small>{entry.type === 'directory' ? 'CARPETA' : entry.type.toUpperCase()}</small>
                  </div>
                ))}
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="lia-servers-r3-grid lia-servers-r3-bottom-grid">
        <article className="lia-servers-r3-card">
          <header><span>BACKUPS</span><b>OBSERVACIÓN</b></header>
          <div className="lia-servers-r3-backup-summary">
            <strong>
              {inventory
                ? inventory.roots.flatMap((root) => root.entries)
                    .filter((entry) => entry.name.toLowerCase().includes('backup')).length
                : '—'}
            </strong>
            <span>directorios relacionados detectados en el mapa visible</span>
          </div>
        </article>

        <article className="lia-servers-r3-card lia-servers-r3-operator">
          <header><span>AGENTE DE OPERACIONES</span><b>DESACTIVADO</b></header>
          <div>
            <strong>Control humano obligatorio</strong>
            <p>El siguiente nivel añadirá acciones administrativas mediante allowlist, auditoría y autorización explícita.</p>
          </div>
          <button type="button" disabled>Acciones administrativas bloqueadas</button>
        </article>
      </section>
    </ExecutiveShellR3>
  );
}
