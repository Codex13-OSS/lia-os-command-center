import {
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from 'react';
import type { LiaUserProfile } from '../../domain/liaUserProfile';
import {
  LiaOpenMeteoWeatherAdapter,
  type LiaWeatherSnapshot,
} from '../../integrations/liaOpenMeteoWeather';
import { LiaBrowserLocationAdapter } from '../../integrations/liaBrowserLocation';
import { readLiaPersonalSession } from '../../integrations/liaPersonalAccountClient';

type StoredLocation = {
  latitude: number;
  longitude: number;
  label: string;
  source: 'device' | 'manual';
  accuracyMeters: number | null;
};

type WeatherVisual =
  | 'clear'
  | 'partly'
  | 'cloudy'
  | 'fog'
  | 'drizzle'
  | 'rain'
  | 'snow'
  | 'storm';

type CssVariables = CSSProperties & {
  [key: `--${string}`]: string | number;
};

function storedLocationFromProfile(
  profile: LiaUserProfile | null,
): StoredLocation | null {
  if (!profile) return null;

  const latitude = profile.location.latitude;
  const longitude = profile.location.longitude;

  if (
    typeof latitude !== 'number' ||
    !Number.isFinite(latitude) ||
    latitude < -90 ||
    latitude > 90 ||
    typeof longitude !== 'number' ||
    !Number.isFinite(longitude) ||
    longitude < -180 ||
    longitude > 180
  ) {
    return null;
  }

  return {
    latitude,
    longitude,
    label: profile.location.label?.trim() || 'Ubicación guardada',
    source: profile.location.source === 'manual' ? 'manual' : 'device',
    accuracyMeters:
      typeof profile.location.accuracyMeters === 'number' &&
      Number.isFinite(profile.location.accuracyMeters)
        ? profile.location.accuracyMeters
        : null,
  };
}

function formatWeatherTime(value: string, language: string): string {
  try {
    return new Intl.DateTimeFormat(language || 'es-MX', {
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(value));
  } catch {
    return value;
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function weatherVisualFromCode(code: number | null): WeatherVisual {
  if (code === null) return 'cloudy';
  if ([95, 96, 99].includes(code)) return 'storm';
  if ([71, 73, 75, 77, 85, 86].includes(code)) return 'snow';
  if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return 'rain';
  if ([51, 53, 55, 56, 57].includes(code)) return 'drizzle';
  if ([45, 48].includes(code)) return 'fog';
  if (code === 3) return 'cloudy';
  if ([1, 2].includes(code)) return 'partly';
  return 'clear';
}

function formatMetric(
  value: number | null,
  digits = 0,
): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return value.toFixed(digits).replace(/\.0$/, '');
}

function buildMapEmbedUrl(
  latitude: number | null,
  longitude: number | null,
): string | null {
  if (latitude === null || longitude === null) return null;

  const latitudeSpan = 0.028;
  const longitudeSpan =
    0.045 / Math.max(Math.cos(latitude * Math.PI / 180), 0.3);

  const west = clamp(longitude - longitudeSpan, -180, 180);
  const east = clamp(longitude + longitudeSpan, -180, 180);
  const south = clamp(latitude - latitudeSpan, -90, 90);
  const north = clamp(latitude + latitudeSpan, -90, 90);

  const query = new URLSearchParams({
    bbox: `${west},${south},${east},${north}`,
    layer: 'mapnik',
    marker: `${latitude},${longitude}`,
  });

  return `https://www.openstreetmap.org/export/embed.html?${query.toString()}`;
}

function LiaLiveWeatherSceneR3({
  weather,
  language,
  locationLabel,
}: {
  weather: LiaWeatherSnapshot;
  language: string;
  locationLabel: string;
}) {
  const visual = weatherVisualFromCode(weather.weatherCode);
  const wind = weather.windSpeedKph ?? 0;
  const precipitation = weather.precipitationMillimeters ?? 0;
  const driftDuration = clamp(24 - wind * 0.45, 6, 24);
  const fallDuration = clamp(1.15 - precipitation * 0.08, 0.42, 1.15);
  const precipitationOpacity = clamp(
    0.48 + precipitation * 0.09,
    0.48,
    0.96,
  );

  const visualStyle: CssVariables = {
    '--lia-weather-drift-duration': `${driftDuration.toFixed(1)}s`,
    '--lia-weather-fall-duration': `${fallDuration.toFixed(2)}s`,
    '--lia-weather-precip-opacity': precipitationOpacity.toFixed(2),
  };

  return (
    <>
      <div
        className={[
          'lia-weather-r3-scene',
          `is-${visual}`,
          weather.isDay === false ? 'is-night' : 'is-day',
        ].join(' ')}
        style={visualStyle}
        role="img"
        aria-label={`${weather.description}, ${weather.temperatureCelsius} grados Celsius en ${locationLabel}`}
      >
        <div className="lia-weather-r3-atmosphere" aria-hidden="true" />
        <span className="lia-weather-r3-sun" aria-hidden="true" />
        <span className="lia-weather-r3-moon" aria-hidden="true" />

        <div className="lia-weather-r3-stars" aria-hidden="true">
          {Array.from({ length: 9 }, (_, index) => <i key={index} />)}
        </div>

        <div className="lia-weather-r3-clouds" aria-hidden="true">
          <span className="is-a" />
          <span className="is-b" />
          <span className="is-c" />
        </div>

        <div className="lia-weather-r3-precipitation" aria-hidden="true">
          {Array.from({ length: 14 }, (_, index) => <i key={index} />)}
        </div>

        <div className="lia-weather-r3-fog" aria-hidden="true">
          <span /><span /><span />
        </div>

        <span className="lia-weather-r3-lightning" aria-hidden="true" />

        <div className="lia-weather-r3-readout">
          <small>CONDICIÓN ACTUAL</small>
          <strong>
            {formatMetric(weather.temperatureCelsius, 1)}
            <sup>°C</sup>
          </strong>
          <span>{weather.description}</span>
        </div>

        <b className="lia-weather-r3-live">DATOS EN VIVO</b>
      </div>

      <div className="lia-weather-r3-metrics">
        <span>
          <small>SENSACIÓN</small>
          <strong>
            {formatMetric(weather.apparentTemperatureCelsius, 1)} °C
          </strong>
        </span>
        <span>
          <small>HUMEDAD</small>
          <strong>{formatMetric(weather.humidityPercent)} %</strong>
        </span>
        <span>
          <small>VIENTO</small>
          <strong>{formatMetric(weather.windSpeedKph, 1)} km/h</strong>
        </span>
        <span>
          <small>PRECIPITACIÓN</small>
          <strong>
            {formatMetric(weather.precipitationMillimeters, 1)} mm
          </strong>
        </span>
      </div>

      <p className="lia-weather-r3-updated">
        Open‑Meteo · {locationLabel} · actualizado{' '}
        {formatWeatherTime(weather.updatedAt!, language)}
      </p>
    </>
  );
}

/* LIA_LIVE_WEATHER_MAP_V36 */
export function LiaLocationWeatherR3(
  { locationOnly = false }: { locationOnly?: boolean } = {},
) {
  const locationAdapter = useMemo(() => new LiaBrowserLocationAdapter(), []);
  const weatherAdapter = useMemo(() => new LiaOpenMeteoWeatherAdapter(), []);

  const browserLocation = useSyncExternalStore(
    locationAdapter.subscribe,
    locationAdapter.getSnapshot,
    locationAdapter.getSnapshot,
  );
  const weather = useSyncExternalStore(
    weatherAdapter.subscribe,
    weatherAdapter.getSnapshot,
    weatherAdapter.getSnapshot,
  );

  const [profile, setProfile] = useState<LiaUserProfile | null>(null);
  const [profileChecked, setProfileChecked] = useState(false);

  useEffect(() => {
    let active = true;

    void readLiaPersonalSession()
      .then((session) => {
        if (active && session.authenticated) setProfile(session.profile);
      })
      .finally(() => {
        if (active) setProfileChecked(true);
      });

    return () => {
      active = false;
    };
  }, []);

  const storedLocation = useMemo(
    () => storedLocationFromProfile(profile),
    [profile],
  );

  const browserAvailable =
    browserLocation.state === 'available' &&
    browserLocation.latitude !== null &&
    browserLocation.longitude !== null;

  const latitude =
    storedLocation?.latitude ??
    (browserAvailable ? browserLocation.latitude : null);
  const longitude =
    storedLocation?.longitude ??
    (browserAvailable ? browserLocation.longitude : null);
  const accuracyMeters =
    storedLocation?.accuracyMeters ??
    (browserAvailable ? browserLocation.accuracyMeters : null);

  const available = latitude !== null && longitude !== null;
  const language = profile?.locale.language || 'es-MX';
  const locationLabel =
    storedLocation?.label ||
    (browserAvailable ? 'Ubicación actual' : 'Ubicación no configurada');

  useEffect(() => {
    if (latitude === null || longitude === null) return;

    const refresh = () => {
      void weatherAdapter.load(latitude, longitude);
    };

    refresh();
    const timer = window.setInterval(refresh, 10 * 60 * 1000);

    return () => window.clearInterval(timer);
  }, [latitude, longitude, weatherAdapter]);

  const mapEmbedUrl = useMemo(
    () => buildMapEmbedUrl(latitude, longitude),
    [latitude, longitude],
  );

  const mapUrl =
    latitude !== null && longitude !== null
      ? `https://www.openstreetmap.org/?mlat=${encodeURIComponent(latitude)}&mlon=${encodeURIComponent(longitude)}#map=16/${encodeURIComponent(latitude)}/${encodeURIComponent(longitude)}`
      : null;

  return (
    <>
      <section
        className="lia-command-r3-location"
        aria-label="Ubicación configurada"
      >
        <header>
          <span>UBICACIÓN</span>
          <small>
            {storedLocation
              ? storedLocation.source === 'manual'
                ? 'PERFIL · CIUDAD'
                : 'PERFIL · DISPOSITIVO'
              : 'LECTURA LOCAL'}
          </small>
        </header>

        <div
          className={`lia-command-r3-mini-map${available ? ' is-live' : ''}`}
          aria-label={
            available
              ? `Mapa real centrado en ${locationLabel}`
              : 'Ubicación no disponible'
          }
        >
          {mapEmbedUrl ? (
            <iframe
              src={mapEmbedUrl}
              title={`Mapa de ${locationLabel}`}
              loading="lazy"
              referrerPolicy="strict-origin-when-cross-origin"
              tabIndex={-1}
            />
          ) : (
            <div className="lia-map-r3-fallback" aria-hidden="true" />
          )}

          <span className="lia-map-r3-scan" aria-hidden="true" />
          <span className="lia-map-r3-marker" aria-hidden="true"><b /></span>

          {available && (
            <div className="lia-map-r3-location-label">
              <strong>{locationLabel}</strong>
              <small>
                {latitude.toFixed(4)}, {longitude.toFixed(4)}
              </small>
            </div>
          )}

          <b className="lia-map-r3-live-label">
            {available ? 'POSICIÓN REAL' : 'SIN POSICIÓN'}
          </b>
        </div>

        {available ? (
          <>
            <strong>{locationLabel}</strong>
            <small>
              {latitude.toFixed(3)}, {longitude.toFixed(3)}
              {accuracyMeters === null
                ? storedLocation?.source === 'manual'
                  ? ' · ciudad seleccionada'
                  : ' · precisión no indicada'
                : ` · precisión aprox. ${Math.round(accuracyMeters)} m`}
            </small>
            <em>
              {storedLocation
                ? 'Guardada en tu perfil personal'
                : 'Lectura temporal; puedes guardarla desde Configuración'}
            </em>
            {mapUrl && (
              <a
                className="lia-command-r3-map-link"
                href={mapUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                Abrir mapa interactivo
              </a>
            )}
          </>
        ) : (
          <>
            <strong>
              {profileChecked
                ? 'Ubicación no configurada'
                : 'Leyendo ubicación del perfil…'}
            </strong>
            <small>
              {browserLocation.error ??
                'Permite ubicación o guarda una ciudad desde Configuración.'}
            </small>
            <button
              type="button"
              onClick={() => locationAdapter.request()}
              disabled={
                !browserLocation.supported ||
                browserLocation.state === 'requesting'
              }
            >
              {browserLocation.state === 'requesting'
                ? 'Solicitando…'
                : 'Usar ubicación temporal'}
            </button>
          </>
        )}
      </section>

      {!locationOnly && (
        <section
          className="lia-command-r3-weather"
          aria-label="Clima actual de Open-Meteo"
          aria-live="polite"
        >
          <header>
            <span>CLIMA</span>
            <small>OPEN‑METEO · LIVE</small>
          </header>

          {!available ? (
            <>
              <strong>Clima requiere ubicación</strong>
              <p>Configura una ciudad o concede permiso temporal.</p>
            </>
          ) : weather.state === 'loading' || weather.state === 'idle' ? (
            <>
              <strong>Consultando clima actual…</strong>
              <p>Sincronizando telemetría meteorológica.</p>
            </>
          ) : weather.state === 'available' ? (
            <LiaLiveWeatherSceneR3
              weather={weather}
              language={language}
              locationLabel={locationLabel}
            />
          ) : (
            <>
              <strong>Clima temporalmente no disponible</strong>
              <p>Open‑Meteo no respondió con una lectura válida.</p>
            </>
          )}
        </section>
      )}
    </>
  );
}
