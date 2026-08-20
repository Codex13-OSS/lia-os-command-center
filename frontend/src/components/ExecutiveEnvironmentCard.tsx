import { useEffect, useMemo, useState } from 'react';
import { readLiaPersonalSession } from '../integrations/liaPersonalAccountClient';

type EnvironmentVariant = 'login' | 'compact';
type WeatherTone = 'sun' | 'partly' | 'cloud' | 'rain' | 'storm' | 'night';

type WeatherState = {
  city: string;
  temperature: number | null;
  condition: string;
  code: number | null;
};

type LocaleState = {
  language: string;
  timezone: string;
};

function unavailableWeather(
  city = 'Ubicación no configurada',
): WeatherState {
  return {
    city,
    temperature: null,
    condition: 'Clima no disponible',
    code: null,
  };
}

function labelFromCode(code: number): string {
  if (code === 0) return 'Despejado';
  if ([1, 2, 3].includes(code)) return 'Parcialmente nublado';
  if ([45, 48].includes(code)) return 'Neblina';
  if ([51, 53, 55, 56, 57, 61, 63, 65, 80, 81, 82].includes(code)) return 'Lluvia';
  if ([71, 73, 75, 77, 85, 86].includes(code)) return 'Nieve';
  if ([95, 96, 99].includes(code)) return 'Tormenta';
  return 'Clima estable';
}

function toneFromCode(
  code: number | null,
  hour: number,
): WeatherTone {
  const night = hour >= 19 || hour < 6;

  if (code === null) return night ? 'night' : 'partly';
  if ([95, 96, 99].includes(code)) return 'storm';
  if ([51, 53, 55, 56, 57, 61, 63, 65, 80, 81, 82].includes(code)) return 'rain';
  if ([45, 48, 71, 73, 75, 77, 85, 86].includes(code)) return 'cloud';
  if ([1, 2, 3].includes(code)) return night ? 'night' : 'partly';
  if (code === 0) return night ? 'night' : 'sun';

  return night ? 'night' : 'partly';
}

function formatTime(
  date: Date,
  language: string,
  timezone: string,
): string {
  try {
    return new Intl.DateTimeFormat(language, {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: timezone,
    }).format(date);
  } catch {
    return date.toLocaleTimeString('es-MX', {
      hour: '2-digit',
      minute: '2-digit',
    });
  }
}

function formatDate(
  date: Date,
  language: string,
  timezone: string,
): string {
  try {
    return new Intl.DateTimeFormat(language, {
      weekday: 'short',
      day: '2-digit',
      month: 'short',
      timeZone: timezone,
    }).format(date);
  } catch {
    return date.toLocaleDateString('es-MX', {
      weekday: 'short',
      day: '2-digit',
      month: 'short',
    });
  }
}

/* LIA_PROFILE_ENVIRONMENT_CARD_V34 */
export function ExecutiveEnvironmentCard(
  { variant = 'compact' }: { variant?: EnvironmentVariant },
) {
  const [now, setNow] = useState(() => new Date());
  const [weather, setWeather] = useState<WeatherState>(
    () => unavailableWeather(),
  );
  const [locale, setLocale] = useState<LocaleState>(() => ({
    language:
      typeof navigator === 'undefined'
        ? 'es-MX'
        : navigator.language || 'es-MX',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  }));

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();

    void (async () => {
      try {
        const session = await readLiaPersonalSession();
        if (!active || !session.authenticated) return;

        const profile = session.profile;
        const latitude = profile.location.latitude;
        const longitude = profile.location.longitude;
        const city =
          profile.location.label?.trim() || 'Ubicación guardada';

        setLocale({
          language: profile.locale.language || 'es-MX',
          timezone: profile.locale.timezone || 'UTC',
        });

        if (
          typeof latitude !== 'number' ||
          !Number.isFinite(latitude) ||
          typeof longitude !== 'number' ||
          !Number.isFinite(longitude)
        ) {
          setWeather(unavailableWeather());
          return;
        }

        setWeather(unavailableWeather(city));

        const params = new URLSearchParams({
          latitude: String(latitude),
          longitude: String(longitude),
          current: 'temperature_2m,weather_code',
          timezone: 'auto',
        });

        const response = await fetch(
          `https://api.open-meteo.com/v1/forecast?${params.toString()}`,
          { signal: controller.signal },
        );

        if (!response.ok) throw new Error('weather_unavailable');

        const data = await response.json() as {
          current?: {
            temperature_2m?: unknown;
            weather_code?: unknown;
          };
        };

        const temperature = Number(data.current?.temperature_2m);
        const code = Number(data.current?.weather_code);

        if (
          !Number.isFinite(temperature) ||
          !Number.isInteger(code)
        ) {
          throw new Error('invalid_weather_payload');
        }

        if (active) {
          setWeather({
            city,
            temperature: Math.round(temperature),
            condition: labelFromCode(code),
            code,
          });
        }
      } catch (error) {
        if (
          active &&
          !(error instanceof DOMException && error.name === 'AbortError')
        ) {
          setWeather((current) => unavailableWeather(current.city));
        }
      }
    })();

    return () => {
      active = false;
      controller.abort();
    };
  }, []);

  const tone = useMemo(
    () => toneFromCode(weather.code, now.getHours()),
    [weather.code, now],
  );

  return (
    <aside
      className={`executive-environment-card ${variant} weather-${tone}`}
      aria-label="Hora local y clima"
    >
      <div className="weather-visual" aria-hidden="true">
        <span className="weather-sun-disc" />
        <span className="weather-moon-disc" />
        <span className="weather-star star-one" />
        <span className="weather-star star-two" />
        <span className="weather-cloud cloud-one" />
        <span className="weather-cloud cloud-two" />
        <span className="weather-drop drop-one" />
        <span className="weather-drop drop-two" />
        <span className="weather-drop drop-three" />
        <span className="weather-bolt" />
      </div>

      <div className="environment-data">
        <strong>
          {formatTime(now, locale.language, locale.timezone)}
        </strong>
        <span>
          {formatDate(now, locale.language, locale.timezone)} · {weather.city}
        </span>
        <em>
          {weather.temperature === null
            ? weather.condition
            : `${weather.temperature}°C · ${weather.condition}`}
        </em>
      </div>
    </aside>
  );
}
