export type LiaWorkCapability =
  | 'programming'
  | 'design'
  | 'data'
  | 'marketing'
  | 'sales'
  | 'tracking'
  | 'documents'
  | 'operations'
  | 'servers';

export type LiaAutonomyPreference = 'supervised' | 'balanced' | 'autonomous';

export type LiaOfficeAgentBlueprint = {
  id: string;
  name: string;
  role: string;
  reason: string;
  skills: string[];
  requestedPermissions: string[];
};

export type LiaUserProfile = {
  version: 1;
  onboardingCompleted: boolean;
  identity: {
    displayName: string;
    assistantName: string;
  };
  locale: {
    language: string;
    region: string;
    timezone: string;
  };
  location: {
    permission: 'unknown' | 'granted' | 'denied' | 'unavailable';
    latitude: number | null;
    longitude: number | null;
    /* LIA_PROFILE_LOCATION_METADATA_V33 */
    label?: string;
    source?: 'device' | 'manual';
    accuracyMeters?: number | null;
  };
  voice: {
    voiceURI: string | null;
    label: string;
    language: string;
  };
  work: {
    industry: string;
    capabilities: LiaWorkCapability[];
    tools: string[];
    repetitiveTasks: string;
    autonomy: LiaAutonomyPreference;
    requireApprovalForSensitiveActions: boolean;
  };
  officeBlueprint: {
    generatedAt: string | null;
    agents: LiaOfficeAgentBlueprint[];
  };
};

export const LIA_USER_PROFILE_STORAGE_KEY = 'lia.os.user-profile.v1';

function browserLanguage(): string {
  if (typeof navigator === 'undefined') return 'es-MX';
  return navigator.language || 'es-MX';
}

function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function browserRegion(language: string): string {
  const parts = language.split('-');
  return parts[1]?.toUpperCase() || '';
}

export function createDefaultLiaUserProfile(): LiaUserProfile {
  const language = browserLanguage();
  return {
    version: 1,
    onboardingCompleted: false,
    identity: {
      displayName: '',
      assistantName: 'LÍA',
    },
    locale: {
      language,
      region: browserRegion(language),
      timezone: browserTimezone(),
    },
    location: {
      permission: 'unknown',
      latitude: null,
      longitude: null,
      label: '',
      accuracyMeters: null,
    },
    voice: {
      voiceURI: null,
      label: 'Automática',
      language,
    },
    work: {
      industry: '',
      capabilities: [],
      tools: [],
      repetitiveTasks: '',
      autonomy: 'supervised',
      requireApprovalForSensitiveActions: true,
    },
    officeBlueprint: {
      generatedAt: null,
      agents: [],
    },
  };
}

export function readLiaUserProfile(): LiaUserProfile {
  const fallback = createDefaultLiaUserProfile();
  if (typeof window === 'undefined') return fallback;

  try {
    const raw = window.localStorage.getItem(LIA_USER_PROFILE_STORAGE_KEY);
    if (!raw) return fallback;

    const parsed = JSON.parse(raw) as Partial<LiaUserProfile>;
    if (parsed.version !== 1) return fallback;

    return {
      ...fallback,
      ...parsed,
      identity: { ...fallback.identity, ...parsed.identity },
      locale: { ...fallback.locale, ...parsed.locale },
      location: { ...fallback.location, ...parsed.location },
      voice: { ...fallback.voice, ...parsed.voice },
      work: {
        ...fallback.work,
        ...parsed.work,
        capabilities: Array.isArray(parsed.work?.capabilities) ? parsed.work.capabilities : [],
        tools: Array.isArray(parsed.work?.tools) ? parsed.work.tools : [],
      },
      officeBlueprint: {
        ...fallback.officeBlueprint,
        ...parsed.officeBlueprint,
        agents: Array.isArray(parsed.officeBlueprint?.agents) ? parsed.officeBlueprint.agents : [],
      },
    };
  } catch {
    return fallback;
  }
}

export function writeLiaUserProfile(profile: LiaUserProfile): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(LIA_USER_PROFILE_STORAGE_KEY, JSON.stringify(profile));
  } catch {
    // El perfil permanece en memoria si el navegador bloquea almacenamiento.
  }
}

const agentCatalog: Array<{
  capability: LiaWorkCapability;
  agents: LiaOfficeAgentBlueprint[];
}> = [
  {
    capability: 'programming',
    agents: [
      {
        id: 'architecture',
        name: 'Arquitectura',
        role: 'Arquitecto de software',
        reason: 'Diseña soluciones, contratos y estructura técnica antes de implementar.',
        skills: ['arquitectura', 'repositorios', 'diseño técnico', 'planificación'],
        requestedPermissions: ['repository_read'],
      },
      {
        id: 'implementation',
        name: 'Implementación',
        role: 'Ingeniero de software',
        reason: 'Construye cambios aprobados dentro del workspace autorizado.',
        skills: ['programación', 'refactorización', 'integraciones', 'pruebas locales'],
        requestedPermissions: ['repository_read', 'isolated_worktree_write', 'run_tests'],
      },
      {
        id: 'qa',
        name: 'QA / Verificación',
        role: 'Verificador',
        reason: 'Comprueba funcionalidad y evidencia antes de cerrar trabajo.',
        skills: ['testing', 'QA', 'validación', 'revisión'],
        requestedPermissions: ['repository_read', 'run_tests'],
      },
    ],
  },
  {
    capability: 'design',
    agents: [
      {
        id: 'creative',
        name: 'Dirección creativa',
        role: 'Director creativo',
        reason: 'Mantiene criterio visual, identidad y consistencia.',
        skills: ['dirección de arte', 'branding', 'UX', 'sistemas visuales'],
        requestedPermissions: ['design_asset_read'],
      },
      {
        id: 'designer',
        name: 'Diseño',
        role: 'Diseñador',
        reason: 'Produce piezas y propuestas visuales para los objetivos del usuario.',
        skills: ['diseño gráfico', 'UI', 'contenido visual', 'prototipado'],
        requestedPermissions: ['design_asset_read', 'design_workspace_write'],
      },
    ],
  },
  {
    capability: 'data',
    agents: [{
      id: 'data',
      name: 'Datos',
      role: 'Analista de datos',
      reason: 'Analiza información, métricas y tendencias para apoyar decisiones.',
      skills: ['análisis', 'SQL', 'reportes', 'visualización'],
      requestedPermissions: ['data_source_read'],
    }],
  },
  {
    capability: 'marketing',
    agents: [{
      id: 'marketing',
      name: 'Marketing',
      role: 'Especialista de marketing',
      reason: 'Planea campañas, contenido y adquisición según los objetivos del negocio.',
      skills: ['marketing', 'copy', 'campañas', 'contenido'],
      requestedPermissions: ['marketing_source_read'],
    }],
  },
  {
    capability: 'sales',
    agents: [{
      id: 'crm',
      name: 'Ventas / CRM',
      role: 'Agente comercial',
      reason: 'Organiza prospectos, seguimiento comercial y oportunidades.',
      skills: ['CRM', 'ventas', 'leads', 'seguimiento'],
      requestedPermissions: ['crm_read'],
    }],
  },
  {
    capability: 'tracking',
    agents: [{
      id: 'followup',
      name: 'Seguimiento',
      role: 'Coordinador de seguimiento',
      reason: 'Vigila compromisos, pendientes y próximos movimientos.',
      skills: ['seguimiento', 'agenda', 'recordatorios', 'priorización'],
      requestedPermissions: ['agenda_read'],
    }],
  },
  {
    capability: 'documents',
    agents: [{
      id: 'documents',
      name: 'Documentos',
      role: 'Especialista documental',
      reason: 'Prepara y organiza documentos según los flujos del usuario.',
      skills: ['documentos', 'plantillas', 'revisión', 'archivo'],
      requestedPermissions: ['document_source_read'],
    }],
  },
  {
    capability: 'operations',
    agents: [{
      id: 'operations',
      name: 'Operaciones',
      role: 'Coordinador operativo',
      reason: 'Supervisa procesos repetitivos y dependencias operativas.',
      skills: ['operaciones', 'procesos', 'control', 'incidencias'],
      requestedPermissions: ['operations_read'],
    }],
  },
  {
    capability: 'servers',
    agents: [{
      id: 'server-ops',
      name: 'Infraestructura',
      role: 'Agente de servidores',
      reason: 'Observa infraestructura y propone mantenimiento de forma controlada.',
      skills: ['servidores', 'Docker', 'PM2', 'logs', 'backups'],
      requestedPermissions: ['server_read'],
    }],
  },
];

export function buildLiaOfficeBlueprint(
  capabilities: readonly LiaWorkCapability[],
): LiaOfficeAgentBlueprint[] {
  const selected = new Set(capabilities);
  const agents = agentCatalog
    .filter((entry) => selected.has(entry.capability))
    .flatMap((entry) => entry.agents);

  const unique = new Map<string, LiaOfficeAgentBlueprint>();
  for (const agent of agents) unique.set(agent.id, agent);

  return [...unique.values()];
}
