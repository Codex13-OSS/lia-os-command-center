export type LiaBrowserLocationSnapshot = {
  state: 'idle' | 'requesting' | 'available' | 'unavailable';
  supported: boolean;
  latitude: number | null;
  longitude: number | null;
  accuracyMeters: number | null;
  error: string | null;
};

type GeolocationLike = Pick<Geolocation, 'getCurrentPosition'>;

const unavailable = (supported: boolean, error: string | null = null): LiaBrowserLocationSnapshot => ({
  state: 'unavailable', supported, latitude: null, longitude: null, accuracyMeters: null, error,
});

/** Read-only, in-memory browser location. Coordinates are never persisted or sent. */
export class LiaBrowserLocationAdapter {
  private readonly geolocation?: GeolocationLike;
  private snapshot: LiaBrowserLocationSnapshot;
  private listeners = new Set<() => void>();

  constructor(geolocation: GeolocationLike | undefined = typeof navigator === 'undefined' ? undefined : navigator.geolocation) {
    this.geolocation = geolocation;
    this.snapshot = geolocation
      ? { state: 'idle', supported: true, latitude: null, longitude: null, accuracyMeters: null, error: null }
      : unavailable(false, 'La ubicación no está disponible en este navegador.');
  }

  getSnapshot = (): LiaBrowserLocationSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };

  request(): void {
    if (!this.geolocation || this.snapshot.state === 'requesting') return;
    this.update({ ...this.snapshot, state: 'requesting', error: null });
    this.geolocation.getCurrentPosition(
      (position) => this.update({
        state: 'available', supported: true,
        latitude: position.coords.latitude, longitude: position.coords.longitude,
        accuracyMeters: Number.isFinite(position.coords.accuracy) ? position.coords.accuracy : null,
        error: null,
      }),
      (error) => this.update(unavailable(true, error.code === 1 ? 'Permiso de ubicación no concedido.' : 'No fue posible leer la ubicación.')),
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 300_000 },
    );
  }

  private update(snapshot: LiaBrowserLocationSnapshot): void {
    this.snapshot = snapshot;
    this.listeners.forEach((listener) => listener());
  }
}
