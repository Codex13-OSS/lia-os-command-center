export type LiaWeatherSnapshot = {
  state: 'idle' | 'loading' | 'available' | 'unavailable';
  temperatureCelsius: number | null;
  apparentTemperatureCelsius: number | null;
  weatherCode: number | null;
  description: string | null;
  updatedAt: string | null;
  isDay: boolean | null;
  precipitationMillimeters: number | null;
  windSpeedKph: number | null;
  humidityPercent: number | null;
};

type FetchLike = typeof fetch;

const WEATHER_DESCRIPTIONS: Record<number, string> = {
  0: 'Cielo despejado', 1: 'Mayormente despejado', 2: 'Parcialmente nublado', 3: 'Nublado',
  45: 'Niebla', 48: 'Niebla con escarcha', 51: 'Llovizna ligera', 53: 'Llovizna moderada',
  55: 'Llovizna intensa', 56: 'Llovizna helada ligera', 57: 'Llovizna helada intensa',
  61: 'Lluvia ligera', 63: 'Lluvia moderada', 65: 'Lluvia intensa', 66: 'Lluvia helada ligera',
  67: 'Lluvia helada intensa', 71: 'Nieve ligera', 73: 'Nieve moderada', 75: 'Nieve intensa',
  77: 'Granos de nieve', 80: 'Chubascos ligeros', 81: 'Chubascos moderados', 82: 'Chubascos intensos',
  85: 'Chubascos de nieve ligeros', 86: 'Chubascos de nieve intensos', 95: 'Tormenta',
  96: 'Tormenta con granizo ligero', 99: 'Tormenta con granizo intenso',
};

function emptySnapshot(
  state: LiaWeatherSnapshot['state'],
): LiaWeatherSnapshot {
  return {
    state,
    temperatureCelsius: null,
    apparentTemperatureCelsius: null,
    weatherCode: null,
    description: null,
    updatedAt: null,
    isDay: null,
    precipitationMillimeters: null,
    windSpeedKph: null,
    humidityPercent: null,
  };
}

function finiteNumber(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function nonNegative(value: unknown): number | null {
  const numeric = finiteNumber(value);
  return numeric !== null && numeric >= 0 ? numeric : null;
}

export function describeOpenMeteoWeatherCode(code: number): string {
  return WEATHER_DESCRIPTIONS[code] ?? `Condición meteorológica ${code}`;
}

/* LIA_LIVE_WEATHER_TELEMETRY_V36 */
export class LiaOpenMeteoWeatherAdapter {
  private snapshot: LiaWeatherSnapshot = emptySnapshot('idle');
  private listeners = new Set<() => void>();
  private readonly fetcher: FetchLike | undefined;

  constructor(
    fetcher: FetchLike | undefined =
      typeof window === 'undefined' ? undefined : window.fetch.bind(window),
  ) {
    this.fetcher = fetcher;
  }

  getSnapshot = (): LiaWeatherSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  async load(latitude: number, longitude: number): Promise<void> {
    if (
      !this.fetcher ||
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude)
    ) return;

    if (this.snapshot.state !== 'available') {
      this.update({ ...this.snapshot, state: 'loading' });
    }

    try {
      const query = new URLSearchParams({
        latitude: String(latitude),
        longitude: String(longitude),
        current: [
          'temperature_2m',
          'apparent_temperature',
          'relative_humidity_2m',
          'precipitation',
          'weather_code',
          'wind_speed_10m',
          'is_day',
        ].join(','),
        temperature_unit: 'celsius',
        wind_speed_unit: 'kmh',
        precipitation_unit: 'mm',
        timezone: 'auto',
      });

      const response = await this.fetcher(
        `https://api.open-meteo.com/v1/forecast?${query.toString()}`,
        { cache: 'no-store' },
      );

      if (!response.ok) throw new Error('weather unavailable');

      const body = await response.json() as {
        current?: {
          temperature_2m?: unknown;
          apparent_temperature?: unknown;
          relative_humidity_2m?: unknown;
          precipitation?: unknown;
          weather_code?: unknown;
          wind_speed_10m?: unknown;
          is_day?: unknown;
          time?: unknown;
        };
      };

      const current = body.current;
      const temperature = finiteNumber(current?.temperature_2m);
      const code = finiteNumber(current?.weather_code);
      const updatedAt =
        typeof current?.time === 'string' ? current.time : null;
      const isDayValue = finiteNumber(current?.is_day);
      const humidity = finiteNumber(current?.relative_humidity_2m);

      if (
        temperature === null ||
        code === null ||
        !Number.isInteger(code) ||
        updatedAt === null
      ) {
        throw new Error('invalid weather payload');
      }

      this.update({
        state: 'available',
        temperatureCelsius: temperature,
        apparentTemperatureCelsius:
          finiteNumber(current?.apparent_temperature),
        weatherCode: code,
        description: describeOpenMeteoWeatherCode(code),
        updatedAt,
        isDay:
          isDayValue === 1 ? true :
          isDayValue === 0 ? false :
          null,
        precipitationMillimeters:
          nonNegative(current?.precipitation),
        windSpeedKph:
          nonNegative(current?.wind_speed_10m),
        humidityPercent:
          humidity !== null && humidity >= 0 && humidity <= 100
            ? humidity
            : null,
      });
    } catch {
      this.update(emptySnapshot('unavailable'));
    }
  }

  private update(snapshot: LiaWeatherSnapshot): void {
    this.snapshot = snapshot;
    this.listeners.forEach((listener) => listener());
  }
}
