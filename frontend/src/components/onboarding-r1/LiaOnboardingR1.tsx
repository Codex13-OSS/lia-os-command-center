import { useEffect, useMemo, useState, useRef } from 'react';
import {
  buildLiaOfficeBlueprint,
  type LiaAutonomyPreference,
  type LiaUserProfile,
  type LiaWorkCapability,
} from '../../domain/liaUserProfile';
import '../../styles/liaOnboardingR1.css';

export type LiaRegistrationCredentials = {
  email: string;
  password: string;
};

type Props = {
  initialProfile: LiaUserProfile;
  mode?: 'registration' | 'settings';
  onCancel?: () => void;
  onComplete: (
    profile: LiaUserProfile,
    credentials?: LiaRegistrationCredentials,
  ) => void | Promise<void>;
};

const capabilities: Array<{ id: LiaWorkCapability; title: string; detail: string }> = [
  { id: 'programming', title: 'Programación', detail: 'Software, aplicaciones, repositorios y QA' },
  { id: 'design', title: 'Diseño', detail: 'Identidad, interfaces y contenido visual' },
  { id: 'data', title: 'Análisis de datos', detail: 'Métricas, bases de datos e informes' },
  { id: 'marketing', title: 'Marketing', detail: 'Campañas, contenido y adquisición' },
  { id: 'sales', title: 'Ventas', detail: 'Leads, CRM y seguimiento comercial' },
  { id: 'tracking', title: 'Seguimiento', detail: 'Pendientes, agenda y coordinación' },
  { id: 'documents', title: 'Documentos', detail: 'Generación, revisión y organización' },
  { id: 'operations', title: 'Operaciones', detail: 'Procesos internos y ejecución recurrente' },
  { id: 'servers', title: 'Servidores', detail: 'Infraestructura, servicios y observabilidad' },
];

const baseTools = ['Google Drive', 'Gmail', 'Calendario', 'Excel / Sheets'];
const toolMap: Partial<Record<LiaWorkCapability, string[]>> = {
  programming: ['GitHub', 'Git', 'VS Code', 'Bases de datos'],
  design: ['Figma', 'Adobe', 'Canva'],
  data: ['SQL', 'Power BI', 'Python', 'Excel / Sheets'],
  marketing: ['Meta Ads', 'Google Ads', 'Instagram', 'Canva'],
  sales: ['CRM', 'WhatsApp', 'Correo'],
  tracking: ['Calendario', 'Correo', 'CRM'],
  documents: ['Google Drive', 'Word / Docs', 'PDF'],
  operations: ['ERP', 'CRM', 'Slack'],
  servers: ['SSH', 'Docker', 'PM2', 'Nginx'],
};

function toggle<T>(values: readonly T[], value: T): T[] {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

export function LiaOnboardingR1({
  initialProfile,
  mode = 'settings',
  onCancel,
  onComplete,
}: Props) {
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<LiaUserProfile>(initialProfile);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [locationBusy, setLocationBusy] = useState(false);
  const [manualLocationQuery, setManualLocationQuery] = useState(
    initialProfile.location.label ?? '',
  );
  const [manualLocationBusy, setManualLocationBusy] = useState(false);
  const [manualLocationError, setManualLocationError] = useState<string | null>(null);
  const [registrationEmail, setRegistrationEmail] = useState('');
  const [registrationPassword, setRegistrationPassword] = useState('');
  const [registrationConfirmation, setRegistrationConfirmation] = useState('');
  const [saveBusy, setSaveBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  /* LIA_REGISTRATION_SUBMIT_LOCK_V2 */
  const saveLockRef = useRef(false);

  const tools = useMemo(() => {
    const values = new Set(baseTools);
    for (const capability of draft.work.capabilities) {
      for (const tool of toolMap[capability] ?? []) values.add(tool);
    }
    return [...values];
  }, [draft.work.capabilities]);

  const blueprint = useMemo(
    () => buildLiaOfficeBlueprint(draft.work.capabilities),
    [draft.work.capabilities],
  );

  useEffect(() => {
    if (typeof window === 'undefined' || !window.speechSynthesis) return;

    const load = () => setVoices(window.speechSynthesis.getVoices());
    load();
    window.speechSynthesis.addEventListener?.('voiceschanged', load);
    return () => window.speechSynthesis.removeEventListener?.('voiceschanged', load);
  }, []);

  const languageVoices = voices.filter((voice) =>
    voice.lang.toLowerCase().startsWith(draft.locale.language.split('-')[0].toLowerCase()),
  );

  const setLanguage = (language: string) => {
    setDraft((current) => ({
      ...current,
      locale: {
        ...current.locale,
        language,
        region: language.split('-')[1]?.toUpperCase() ?? current.locale.region,
      },
      voice: { ...current.voice, language, voiceURI: null, label: 'Automática' },
    }));
  };

  const requestLocation = () => {
    if (!navigator.geolocation) {
      setDraft((current) => ({
        ...current,
        location: { ...current.location, permission: 'unavailable' },
      }));
      return;
    }

    setLocationBusy(true);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setDraft((current) => ({
          ...current,
          location: {
            permission: 'granted',
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
            label: 'Ubicación actual',
            source: 'device',
            accuracyMeters: Number.isFinite(position.coords.accuracy)
              ? position.coords.accuracy
              : null,
          },
        }));
        setLocationBusy(false);
      },
      () => {
        setDraft((current) => ({
          ...current,
          location: {
            ...current.location,
            permission: 'denied',
            latitude: null,
            longitude: null,
          },
        }));
        setLocationBusy(false);
      },
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 300000 },
    );
  };

  /* LIA_MANUAL_PROFILE_LOCATION_V33 */
  const resolveManualLocation = async () => {
    const query = manualLocationQuery.trim();

    if (query.length < 2) {
      setManualLocationError('Escribe una ciudad o localidad.');
      return;
    }

    setManualLocationBusy(true);
    setManualLocationError(null);

    try {
      const params = new URLSearchParams({
        name: query,
        count: '1',
        language: draft.locale.language.split('-')[0] || 'es',
        format: 'json',
      });

      const response = await fetch(
        `https://geocoding-api.open-meteo.com/v1/search?${params.toString()}`,
      );

      if (!response.ok) throw new Error('geocoding_unavailable');

      const body = await response.json() as {
        results?: Array<{
          name?: unknown;
          admin1?: unknown;
          country?: unknown;
          country_code?: unknown;
          latitude?: unknown;
          longitude?: unknown;
          timezone?: unknown;
        }>;
      };

      const match = body.results?.[0];
      const latitude = Number(match?.latitude);
      const longitude = Number(match?.longitude);

      if (
        !match ||
        !Number.isFinite(latitude) ||
        !Number.isFinite(longitude) ||
        latitude < -90 ||
        latitude > 90 ||
        longitude < -180 ||
        longitude > 180
      ) {
        throw new Error('location_not_found');
      }

      const label = [match.name, match.admin1, match.country]
        .filter(
          (value): value is string =>
            typeof value === 'string' && value.trim().length > 0,
        )
        .filter((value, index, values) => values.indexOf(value) === index)
        .join(', ');

      setDraft((current) => ({
        ...current,
        locale: {
          ...current.locale,
          region:
            typeof match.country_code === 'string'
              ? match.country_code.toUpperCase()
              : current.locale.region,
          timezone:
            typeof match.timezone === 'string'
              ? match.timezone
              : current.locale.timezone,
        },
        location: {
          permission: 'granted',
          latitude,
          longitude,
          label: label || query,
          source: 'manual',
          accuracyMeters: null,
        },
      }));

      setManualLocationQuery(label || query);
    } catch (error) {
      setManualLocationError(
        error instanceof Error && error.message === 'location_not_found'
          ? 'No encontramos esa localidad. Prueba con ciudad y estado.'
          : 'No fue posible consultar localidades en este momento.',
      );
    } finally {
      setManualLocationBusy(false);
    }
  };

  const finish = async () => {
    if (saveLockRef.current) return;
    saveLockRef.current = true;

    const nextProfile: LiaUserProfile = {
      ...draft,
      onboardingCompleted: true,
      officeBlueprint: {
        generatedAt: new Date().toISOString(),
        agents: blueprint,
      },
    };

    setSaveBusy(true);
    setSaveError(null);

    try {
      await onComplete(
        nextProfile,
        mode === 'registration'
          ? {
              email: registrationEmail.trim().toLowerCase(),
              password: registrationPassword,
            }
          : undefined,
      );
    } catch (error) {
      setSaveError(
        error instanceof Error
          ? error.message
          : 'No fue posible guardar tu configuración.',
      );
    } finally {
      saveLockRef.current = false;
      setSaveBusy(false);
    }
  };

  const registrationAccountValid =
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(registrationEmail.trim()) &&
    registrationPassword.length >= 10 &&
    registrationPassword === registrationConfirmation;

  const canContinue =
    step === 0 && mode === 'registration' ? registrationAccountValid
    : step === 3 ? draft.identity.displayName.trim().length > 0 && draft.identity.assistantName.trim().length > 0
    : step === 5 ? draft.work.industry.trim().length > 0
    : step === 6 ? draft.work.capabilities.length > 0
    : true;

  const progress = ((step + 1) / 10) * 100;

  return (
    <main className="lia-setup-r1">
      <div className="lia-setup-r1-ambient" aria-hidden="true"><i /><i /><i /></div>

      <header className="lia-setup-r1-top">
        <strong>{mode === 'registration' ? 'CREAR TU LÍA' : 'LÍA O.S.'}</strong>
        <div><i style={{ width: `${progress}%` }} /></div>
        <span>{step + 1} / 10</span>
      </header>

      <section key={step} className="lia-setup-r1-stage">
          {step === 0 && (
            mode === 'registration' ? (
              <div className="lia-setup-r1-account">
                <div className="lia-setup-r1-orb" aria-hidden="true"><i /><b>LÍA</b></div>
                <span className="lia-setup-r1-kicker">CREA TU CUENTA</span>
                <h1>Tu espacio personal empieza aquí</h1>
                <p className="lia-setup-r1-copy">
                  Tu configuración y tu oficina quedarán vinculadas únicamente a esta cuenta.
                </p>

                <div className="lia-setup-r1-account-fields">
                  <label>
                    <span>Correo electrónico</span>
                    <input
                      type="email"
                      autoComplete="email"
                      value={registrationEmail}
                      onChange={(event) => setRegistrationEmail(event.target.value)}
                      placeholder="tu@correo.com"
                    />
                  </label>

                  <label>
                    <span>Contraseña</span>
                    <input
                      type="password"
                      autoComplete="new-password"
                      value={registrationPassword}
                      onChange={(event) => setRegistrationPassword(event.target.value)}
                      placeholder="Mínimo 10 caracteres"
                    />
                  </label>

                  <label>
                    <span>Confirma tu contraseña</span>
                    <input
                      type="password"
                      autoComplete="new-password"
                      value={registrationConfirmation}
                      onChange={(event) => setRegistrationConfirmation(event.target.value)}
                      placeholder="Escríbela nuevamente"
                    />
                  </label>
                </div>

                <small className={registrationPassword && !registrationAccountValid ? 'is-visible' : ''}>
                  Usa al menos 10 caracteres y confirma la misma contraseña.
                </small>
              </div>
            ) : (
              <div className="lia-setup-r1-welcome">
                <div className="lia-setup-r1-orb" aria-hidden="true"><i /><b>LÍA</b></div>
                <span>CONFIGURACIÓN PERSONAL</span>
                <h1>Actualiza tu LÍA</h1>
                <p>Modifica tus preferencias sin crear agentes ni ampliar permisos automáticamente.</p>
              </div>
            )
          )}
        {step === 1 && (
          <>
            <span className="lia-setup-r1-kicker">IDIOMA Y REGIÓN</span>
            <h1>¿Cómo quieres usar LÍA?</h1>
            <p className="lia-setup-r1-copy">Esto definirá idioma, formatos y comunicación del sistema.</p>
            <div className="lia-setup-r1-choice-grid">
              {[
                ['es-MX', 'Español', 'México'],
                ['es-ES', 'Español', 'España'],
                ['en-US', 'English', 'United States'],
              ].map(([id, name, region]) => (
                <button key={id} className={draft.locale.language === id ? 'is-selected' : ''} onClick={() => setLanguage(id)}>
                  <strong>{name}</strong><span>{region}</span>
                </button>
              ))}
            </div>
          </>
        )}

          {step === 2 && (
            <>
              <span className="lia-setup-r1-kicker">UBICACIÓN Y TIEMPO</span>
              <h1>Tu contexto local</h1>
              <p className="lia-setup-r1-copy">Usa la ubicación del dispositivo o busca tu ciudad. Sólo guardaremos la opción que confirmes.</p>

              <div className="lia-setup-r1-form-grid">
                <label>
                  <span>Zona horaria</span>
                  <input value={draft.locale.timezone} onChange={(event) => setDraft((current) => ({ ...current, locale: { ...current.locale, timezone: event.target.value } }))} />
                </label>
                <label>
                  <span>Región</span>
                  <input value={draft.locale.region} onChange={(event) => setDraft((current) => ({ ...current, locale: { ...current.locale, region: event.target.value.toUpperCase() } }))} />
                </label>
              </div>

              <button className="lia-setup-r1-location" type="button" onClick={requestLocation} disabled={locationBusy}>
                <i />
                <span>
                  <strong>{draft.location.source === 'device' ? 'Ubicación del dispositivo guardada' : 'Usar ubicación del dispositivo'}</strong>
                  <small>
                    {locationBusy ? 'Solicitando permiso…'
                      : draft.location.source === 'device' ? draft.location.label ?? 'Coordenadas guardadas'
                      : draft.location.permission === 'denied' ? 'Safari no concedió permiso; puedes buscar tu ciudad abajo'
                      : 'Opcional · requiere permiso del navegador'}
                  </small>
                </span>
              </button>

              <div className="lia-setup-r1-manual-location">
                <span>O busca tu ciudad</span>
                <div>
                  <input
                    value={manualLocationQuery}
                    onChange={(event) => setManualLocationQuery(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        void resolveManualLocation();
                      }
                    }}
                    placeholder="Ej. Ciudad de México"
                    aria-label="Ciudad o localidad"
                  />
                  <button
                    type="button"
                    onClick={() => void resolveManualLocation()}
                    disabled={manualLocationBusy || manualLocationQuery.trim().length < 2}
                  >
                    {manualLocationBusy ? 'Buscando…' : 'Guardar ciudad'}
                  </button>
                </div>
                {manualLocationError
                  ? <small className="is-error">{manualLocationError}</small>
                  : draft.location.source === 'manual'
                    ? <small className="is-saved">Guardada · {draft.location.label}</small>
                    : <small>Open-Meteo buscará coordenadas y zona horaria reales.</small>}
              </div>
            </>
          )}

        {step === 3 && (
          <>
            <span className="lia-setup-r1-kicker">IDENTIDAD</span>
            <h1>Preséntense</h1>
            <p className="lia-setup-r1-copy">Dinos cómo llamarte y cómo quieres llamar a tu asistente.</p>
            <div className="lia-setup-r1-form-grid is-stack">
              <label><span>Tu nombre</span><input autoFocus value={draft.identity.displayName} onChange={(event) => setDraft((current) => ({ ...current, identity: { ...current.identity, displayName: event.target.value } }))} placeholder="¿Cómo te llamas?" /></label>
              <label><span>Nombre del asistente</span><input value={draft.identity.assistantName} onChange={(event) => setDraft((current) => ({ ...current, identity: { ...current.identity, assistantName: event.target.value } }))} placeholder="LÍA" /></label>
            </div>
          </>
        )}

        {step === 4 && (
          <>
            <span className="lia-setup-r1-kicker">VOZ</span>
            <h1>Elige cómo quieres que te hable</h1>
            <p className="lia-setup-r1-copy">Usaremos las voces disponibles en tu dispositivo.</p>
            <div className="lia-setup-r1-voice-list">
              <button className={draft.voice.voiceURI === null ? 'is-selected' : ''} onClick={() => setDraft((current) => ({ ...current, voice: { ...current.voice, voiceURI: null, label: 'Automática' } }))}>
                <i /><span><strong>Automática</strong><small>LÍA elegirá una voz compatible</small></span>
              </button>
              {languageVoices.slice(0, 8).map((voice) => (
                <button key={voice.voiceURI} className={draft.voice.voiceURI === voice.voiceURI ? 'is-selected' : ''} onClick={() => setDraft((current) => ({ ...current, voice: { language: voice.lang, voiceURI: voice.voiceURI, label: voice.name } }))}>
                  <i /><span><strong>{voice.name}</strong><small>{voice.lang}</small></span>
                </button>
              ))}
            </div>
          </>
        )}

        {step === 5 && (
          <>
            <span className="lia-setup-r1-kicker">TU TRABAJO</span>
            <h1>¿A qué te dedicas?</h1>
            <p className="lia-setup-r1-copy">No necesitamos una categoría perfecta. Describe tu actividad o el giro de tu empresa.</p>
            <label className="lia-setup-r1-big-field">
              <input autoFocus value={draft.work.industry} onChange={(event) => setDraft((current) => ({ ...current, work: { ...current.work, industry: event.target.value } }))} placeholder="Ej. inmobiliaria, desarrollo de software, despacho jurídico…" />
            </label>
            <label className="lia-setup-r1-big-field">
              <textarea value={draft.work.repetitiveTasks} onChange={(event) => setDraft((current) => ({ ...current, work: { ...current.work, repetitiveTasks: event.target.value } }))} placeholder="¿Qué tareas te consumen tiempo o repites constantemente?" />
            </label>
          </>
        )}

        {step === 6 && (
          <>
            <span className="lia-setup-r1-kicker">NECESIDADES</span>
            <h1>¿En qué quieres que trabajen tus agentes?</h1>
            <p className="lia-setup-r1-copy">Selecciona todo lo que aplique. Esto determina la composición inicial de tu oficina.</p>
            <div className="lia-setup-r1-capabilities">
              {capabilities.map((item) => (
                <button key={item.id} className={draft.work.capabilities.includes(item.id) ? 'is-selected' : ''} onClick={() => setDraft((current) => ({ ...current, work: { ...current.work, capabilities: toggle(current.work.capabilities, item.id) } }))}>
                  <i />
                  <span><strong>{item.title}</strong><small>{item.detail}</small></span>
                </button>
              ))}
            </div>
          </>
        )}

        {step === 7 && (
          <>
            <span className="lia-setup-r1-kicker">HERRAMIENTAS Y AUTONOMÍA</span>
            <h1>¿Cómo será tu entorno de trabajo?</h1>
            <div className="lia-setup-r1-tool-grid">
              {tools.map((tool) => (
                <button key={tool} className={draft.work.tools.includes(tool) ? 'is-selected' : ''} onClick={() => setDraft((current) => ({ ...current, work: { ...current.work, tools: toggle(current.work.tools, tool) } }))}>{tool}</button>
              ))}
            </div>

            <div className="lia-setup-r1-autonomy">
              <span>Nivel inicial de autonomía</span>
              {([
                ['supervised', 'Supervisada', 'LÍA propone y tú autorizas acciones importantes.'],
                ['balanced', 'Equilibrada', 'Más trabajo automático dentro de límites definidos.'],
                ['autonomous', 'Avanzada', 'Máxima autonomía permitida por las políticas del sistema.'],
              ] as Array<[LiaAutonomyPreference,string,string]>).map(([id,title,copy]) => (
                <button key={id} className={draft.work.autonomy === id ? 'is-selected' : ''} onClick={() => setDraft((current) => ({ ...current, work: { ...current.work, autonomy: id } }))}>
                  <strong>{title}</strong><small>{copy}</small>
                </button>
              ))}
            </div>
          </>
        )}

        {step === 8 && (
          <>
            <span className="lia-setup-r1-kicker">TU OFICINA</span>
            <h1>Esta es la oficina que LÍA recomienda</h1>
            <p className="lia-setup-r1-copy">Es una propuesta. Ningún agente ni permiso se activa todavía.</p>
            <div className="lia-setup-r1-office">
              {blueprint.map((agent, index) => (
                <article key={agent.id}>
                  <div><b>{String(index + 1).padStart(2, '0')}</b><i /></div>
                  <span>
                    <strong>{agent.name}</strong>
                    <small>{agent.role}</small>
                    <p>{agent.reason}</p>
                  </span>
                  <em>{agent.skills.slice(0,3).join(' · ')}</em>
                </article>
              ))}
            </div>
          </>
        )}

        {step === 9 && (
          <div className="lia-setup-r1-welcome">
            <div className="lia-setup-r1-orb is-ready" aria-hidden="true"><i /><b>{draft.identity.assistantName || 'LÍA'}</b></div>
            <span>CONFIGURACIÓN LISTA</span>
            <h1>Tu LÍA ya te conoce</h1>
            <p>
              {blueprint.length} agentes recomendados · {draft.work.capabilities.length} áreas de trabajo ·
              autonomía {draft.work.autonomy === 'supervised' ? ' supervisada' : draft.work.autonomy === 'balanced' ? ' equilibrada' : ' avanzada'}.
            </p>
          </div>
        )}
      </section>

      <footer className="lia-setup-r1-actions">
        <button
          type="button"
          className="is-back"
          disabled={step === 0 && !onCancel}
          onClick={() => {
            setSaveError(null);
            if (step === 0) onCancel?.();
            else setStep((current) => Math.max(0, current - 1));
          }}
        >
          {step === 0 && onCancel ? 'Volver al acceso' : 'Atrás'}
        </button>

        {saveError && (
          <p className="lia-setup-r1-save-error" role="alert">{saveError}</p>
        )}

        {step < 9 ? (
          <button
            type="button"
            className="is-next"
            disabled={!canContinue}
            onClick={() => {
              setSaveError(null);
              setStep((current) => current + 1);
            }}
          >
            Continuar
          </button>
        ) : (
          <button
            type="button"
            className="is-next"
            disabled={saveBusy}
            onClick={() => void finish()}
          >
            {saveBusy
              ? 'Guardando…'
              : mode === 'registration'
                ? 'Crear mi cuenta'
                : 'Guardar configuración'}
          </button>
        )}
      </footer>
    </main>
  );
}
