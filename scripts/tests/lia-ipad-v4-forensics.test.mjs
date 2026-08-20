import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { LiaOpenMeteoWeatherAdapter, describeOpenMeteoWeatherCode } from '../../frontend/src/integrations/liaOpenMeteoWeather.ts';

const source = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('the exact sidebar resize stripe and compact Core decorations are non-painting', async () => {
  const styles = await source('../../frontend/src/styles/dashboardExecutiveR3.css');
  assert.match(styles, /\.lia-dash-r3-resize-handle \{ height: auto; top: 70px; bottom: 70px; \}/);
  assert.match(styles, /\.lia-dash-r3-resize-handle::after \{ content: none; display: none; \}/);
  const compactRule = styles.match(/\.lia-core-r3\.is-compact \.lia-core-r3-stage::before,[\s\S]*?\{ display: none; content: none; \}/)?.[0] ?? '';
  for (const selector of ['stage::before', 'stage::after', 'halo', 'orbit', 'signal', 'ambient-line', 'particle', 'base-shadow']) assert.match(compactRule, new RegExp(selector.replace('-', '\\-')));
});

test('page authorities are content-sized and do not create a second internal viewport', async () => {
  const [dashboard, agenda, projects, office] = await Promise.all([
    source('../../frontend/src/styles/dashboardExecutiveR3.css'),
    source('../../frontend/src/styles/agendaExecutiveR3.css'),
    source('../../frontend/src/styles/projectsExecutiveR3.css'),
    source('../../frontend/src/styles/officeExecutiveR3.css'),
  ]);
  for (const css of [dashboard, agenda, projects, office]) assert.match(css, /height:auto[^}]*min-height:(?:0|100dvh)/);
  assert.match(dashboard, /\.lia-dash-r3-main \{ height: auto; min-height: 0; align-self: start; overflow: visible; \}/);
  assert.match(agenda, /\.lia-agenda-r3-layout \{ height:auto;min-height:0;flex:0 0 auto;align-items:start;overflow:visible; \}/);
  assert.match(projects, /\.lia-projects-r3-chat,\.lia-projects-r3-thread \{ height:auto;min-height:0;flex:0 0 auto;overflow:visible; \}/);
  assert.match(office, /\.lia-office-r3-shell \.lia-dash-r3-main,\.lia-office-r3-content \{ height:auto;min-height:0;align-self:start;overflow:visible; \}/);
});

test('Open-Meteo adapter is explicit, deterministic and only fetches when load receives coordinates', async () => {
  const calls = [];
  const adapter = new LiaOpenMeteoWeatherAdapter(async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ current: { temperature_2m: 17.4, weather_code: 2, time: '2026-08-18T12:00' } }), { status: 200 });
  });
  assert.equal(calls.length, 0);
  assert.equal(adapter.getSnapshot().state, 'idle');
  await adapter.load(19.43, -99.13);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /api\.open-meteo\.com/);
  assert.match(calls[0], /latitude=19\.43/);
  for (const field of ['apparent_temperature', 'relative_humidity_2m', 'precipitation', 'wind_speed_10m', 'is_day']) {
    assert.match(calls[0], new RegExp(field));
  }
  assert.deepEqual(adapter.getSnapshot(), {
    state: 'available',
    temperatureCelsius: 17.4,
    apparentTemperatureCelsius: null,
    weatherCode: 2,
    description: 'Parcialmente nublado',
    updatedAt: '2026-08-18T12:00',
    isDay: null,
    precipitationMillimeters: null,
    windSpeedKph: null,
    humidityPercent: null,
  });
  assert.equal(describeOpenMeteoWeatherCode(95), 'Tormenta');
});
