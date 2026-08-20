import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('Premium command center exposes only evidence-backed attention and activity', async () => {
  const [dashboard, navigation, agenda] = await Promise.all([
    source('../../frontend/src/components/dashboard-r3/DashboardCommandCenterR3.tsx'),
    source('../../frontend/src/data/dashboardShellR3Data.ts'),
    source('../../frontend/src/components/agenda-r3/AgendaShellR3.tsx'),
  ]);
  assert.doesNotMatch(dashboard, /mockDashboard|dashboardMetricsR3|recentActivityR3|Cadencia estable|Acciones listas|riesgo ['"]Medio/iu);
  const approvedNavigation = navigation.match(/dashboardNavigationR3[\s\S]*?] as const/)?.[0] ?? '';
  for (const label of ['Inicio', 'Agenda', 'Proyectos', 'Oficina', 'Servidores', 'Documentos', 'Configuración']) {
    assert.match(approvedNavigation, new RegExp(`label: '${label}'`));
  }
  assert.doesNotMatch(approvedNavigation, /label: 'Alertas'|label: 'Procesos'/);
  assert.match(agenda, /seedEvents: \[\]/);
  assert.match(agenda, /event\.source !== 'seed'/);
});

test('shared Core is an orb and compact sidebar Core has no full-height stripe', async () => {
  const [core, styles] = await Promise.all([
    source('../../frontend/src/components/lia-core-r3/LiaCoreR3.tsx'),
    source('../../frontend/src/styles/dashboardExecutiveR3.css'),
  ]);
  assert.match(core, /lia-core-r3-orb/);
  assert.match(styles, /\.lia-core-r3\.is-compact \.lia-core-r3-stage \{ width: 50px; height: 50px; flex: 0 0 50px; overflow: hidden/);
  assert.match(styles, /\.lia-dash-r3-resize-handle::after \{ content: none; display: none; \}/);
  assert.match(styles, /\.lia-core-r3\.is-compact \.lia-core-r3-halo,[\s\S]*?display: none; content: none;/);
  const operatorRules = styles.match(/\.lia-dash-r3-operator-tile[^}]*\}/g)?.join('\n') ?? '';
  assert.doesNotMatch(operatorRules, /height:\s*100(?:vh|dvh|%)/);
  assert.doesNotMatch(styles, /lia-core[^}]*height:\s*100(?:vh|dvh)/);
});

test('voice remains feature-detected, timer-free and visibly disabled when unsupported', async () => {
  const [adapter, header, panel, surface, projects, reopened] = await Promise.all([
    source('../../frontend/src/integrations/liaBrowserVoice.ts'),
    source('../../frontend/src/components/dashboard-r3/DashboardHeaderR3.tsx'),
    source('../../frontend/src/components/lia-r3/LiaConversationPanelR3.tsx'),
    source('../../frontend/src/components/lia-r3/LiaVoiceSurfaceR3.tsx'),
    source('../../frontend/src/components/projects-r3/ProjectsShellR3.tsx'),
    source('../../frontend/docs/P12_CROSS_BROWSER_VOICE_REOPENED.md'),
  ]);
  assert.doesNotMatch(adapter, /setTimeout|setInterval|MediaRecorder|getUserMedia/);
  assert.doesNotMatch(header, /lia-dash-r3-voice-trigger/);
  assert.match(panel, /disabled=\{controller\.pending \|\| !controller\.voice\.recognitionSupported\}/);
  assert.match(surface, /Recognition/);
  assert.match(surface, /Synthesis/);
  assert.match(surface, /disabled=\{!supported/);
  assert.match(projects, /lia-projects-r3-voice-access/);
  assert.match(panel, /Voz no disponible en este navegador\./);
  assert.match(reopened, /REABIERTO/);
});

test('Core hero has real depth layers and semantic motion with static reduced-motion identity', async () => {
  const [core, styles] = await Promise.all([
    source('../../frontend/src/components/lia-core-r3/LiaCoreR3.tsx'),
    source('../../frontend/src/styles/dashboardExecutiveR3.css'),
  ]);
  for (const layer of ['lia-core-r3-shell', 'lia-core-r3-membrane', 'lia-core-r3-inner-glow', 'lia-core-r3-specular', 'lia-core-r3-orbit-c']) assert.match(core, new RegExp(layer));
  for (const state of ['is-idle', 'is-planning', 'is-delegating', 'is-executing', 'is-verifying', 'is-correcting', 'is-waiting_human', 'is-listening', 'is-speaking']) assert.match(styles, new RegExp(state));
  assert.match(styles, /prefers-reduced-motion:reduce/);
});

test('Premium context rail uses real read models and honest location/weather fallbacks', async () => {
  const [dashboard, location, agenda, weather, weatherSurface] = await Promise.all([
    source('../../frontend/src/components/dashboard-r3/DashboardCommandCenterR3.tsx'),
    source('../../frontend/src/integrations/liaBrowserLocation.ts'),
    source('../../frontend/src/components/agenda-r3/AgendaExecutiveRailR3.tsx'),
    source('../../frontend/src/integrations/liaOpenMeteoWeather.ts'),
    source('../../frontend/src/components/dashboard-r3/LiaLocationWeatherR3.tsx'),
  ]);
  for (const field of ['Agentes activos', 'Ejecuciones', 'Goals activos', 'Atención humana', 'Failed / fail-closed', 'Hermes']) assert.match(dashboard, new RegExp(field));
  assert.match(location, /navigator\.geolocation/);
  assert.doesNotMatch(location, /localStorage|fetch\(|XMLHttpRequest/);
  assert.match(dashboard, /LiaLocationWeatherR3/);
  assert.match(agenda, /LiaLocationWeatherR3/);
  assert.match(weather, /api\.open-meteo\.com/);
  assert.match(weatherSurface, /Clima requiere ubicación/);
  assert.match(weatherSurface, /Clima temporalmente no disponible/);
  assert.match(weatherSurface, /openstreetmap\.org/);
  assert.doesNotMatch(`${dashboard}\n${agenda}\n${weatherSurface}`, /24°C|Datos simulados|Ciudad de México|CDMX/);
});

test('Premium page content has no internal viewport-height filler', async () => {
  const [dashboard, projects, agenda, office] = await Promise.all([
    source('../../frontend/src/styles/dashboardExecutiveR3.css'),
    source('../../frontend/src/styles/projectsExecutiveR3.css'),
    source('../../frontend/src/styles/agendaExecutiveR3.css'),
    source('../../frontend/src/styles/officeExecutiveR3.css'),
  ]);
  assert.doesNotMatch(projects, /\.lia-projects-r3-shell \.lia-dash-r3-main[^}]*height:\s*(?:100d?vh|calc\(100dvh)/);
  assert.doesNotMatch(agenda, /\.lia-agenda-r3-shell \.lia-dash-r3-main[^}]*height:\s*100d?vh/);
  assert.doesNotMatch(office, /\.lia-office-r3-content[^}]*height:\s*100d?vh/);
  assert.match(dashboard, /\.lia-command-r3-shell \.lia-dash-r3-main \{ min-height:0; overflow:visible; \}/);
});

test('iPad command layout uses one page scroll without artificial internal page heights', async () => {
  const styles = await source('../../frontend/src/styles/dashboardExecutiveR3.css');
  const recovery = styles.slice(styles.indexOf('Visual recovery'));
  assert.match(recovery, /max-width: 1440px/);
  assert.match(recovery, /grid-template-columns: min\(var\(--lia-dash-r3-sidebar-width\), 230px\)/);
  assert.match(recovery, /\.lia-command-r3-shell \.lia-dash-r3-main \{ grid-column: 2; min-height: 0; overflow: visible; \}/);
  assert.doesNotMatch(recovery, /\.lia-command-r3-shell \.lia-dash-r3-main[^}]*height:\s*(?:100d?vh|[89]\d\dpx)/);
});

test('Office is a responsive 2.5D scene with an overlay inspector', async () => {
  const [component, styles] = await Promise.all([
    source('../../frontend/src/components/office-r3/OfficeShellR3.tsx'),
    source('../../frontend/src/styles/officeExecutiveR3.css'),
  ]);
  for (const token of ['is-hub', 'is-architecture', 'is-implementation', 'is-verification', 'is-risk', 'lia-office-r3-waiting', 'lia-office-r3-boardroom']) assert.match(component, new RegExp(token));
  assert.match(component, /rail=\{null\}/);
  assert.match(component, /lia-office-r3-inspector-layer/);
  assert.match(component, /onClick=\{\(\) => setSelectedId\(null\)\}/);
  assert.match(styles, /perspective: 900px/);
  assert.match(styles, /max-width: 720px[\s\S]*height: min\(72dvh, 610px\)/);
  assert.doesNotMatch(styles, /\.lia-office-r3-content[^}]*height:\s*100d?vh/);
});
