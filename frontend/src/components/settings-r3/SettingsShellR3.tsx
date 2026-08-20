import { ExecutiveShellR3 } from '../executive-r3/ExecutiveShellR3';
import type { LiaConversationController } from '../lia-r3/liaConversationController';
import type { LiaUserProfile } from '../../domain/liaUserProfile';
import '../../styles/settingsExecutiveR3.css';

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
  profile: LiaUserProfile;
  onReconfigure: () => void;
};

export function SettingsShellR3(props: Props) {
  const { profile } = props;

  return (
    <ExecutiveShellR3
      {...props}
      activeSection="settings"
      mainAriaLabel="Configuración de LÍA"
      mainClassName="lia-settings-r3-shell"
      rail={null}
    >
      <header className="lia-settings-r3-title">
        <div><span>PERFIL PERSONAL</span><h1>Configuración</h1><p>Tu identidad, contexto y forma de trabajar con LÍA.</p></div>
        <button type="button" onClick={props.onReconfigure}>Revisar configuración</button>
      </header>

      <section className="lia-settings-r3-grid">
        <article>
          <span>IDENTIDAD</span>
          <strong>{profile.identity.displayName || 'Sin nombre'}</strong>
          <dl>
            <div><dt>Asistente</dt><dd>{profile.identity.assistantName}</dd></div>
            <div><dt>Idioma</dt><dd>{profile.locale.language}</dd></div>
            <div><dt>Región</dt><dd>{profile.locale.region || '—'}</dd></div>
            <div><dt>Zona horaria</dt><dd>{profile.locale.timezone}</dd></div>
          </dl>
        </article>

        <article>
          <span>VOZ Y CONTEXTO</span>
          <strong>{profile.voice.label}</strong>
          <dl>
            <div><dt>Voz</dt><dd>{profile.voice.voiceURI ? 'Personalizada' : 'Automática'}</dd></div>
            <div><dt>Ubicación</dt><dd>{profile.location.permission}</dd></div>
            <div><dt>Idioma de voz</dt><dd>{profile.voice.language}</dd></div>
          </dl>
        </article>

        <article>
          <span>ACTIVIDAD</span>
          <strong>{profile.work.industry || 'Sin definir'}</strong>
          <div className="lia-settings-r3-tags">
            {profile.work.capabilities.map((item) => <i key={item}>{item}</i>)}
          </div>
        </article>

        <article>
          <span>OFICINA RECOMENDADA</span>
          <strong>{profile.officeBlueprint.agents.length} agentes</strong>
          <div className="lia-settings-r3-agents">
            {profile.officeBlueprint.agents.map((agent) => (
              <div key={agent.id}><i /><span><b>{agent.name}</b><small>{agent.role}</small></span></div>
            ))}
          </div>
        </article>
      </section>

      <section className="lia-settings-r3-safety">
        <div><span>AUTONOMÍA</span><strong>{profile.work.autonomy}</strong></div>
        <p>El perfil expresa preferencias del usuario, pero nunca amplía por sí mismo las capacidades autorizadas de LÍA ni de sus agentes.</p>
      </section>
    </ExecutiveShellR3>
  );
}
