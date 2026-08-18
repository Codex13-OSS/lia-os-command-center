import type { MobilityDashboardRequestR3, MobilityDashboardSnapshotR3 } from '../domain/mobilityR3';

export interface MobilityProviderR3 {
  getDashboardSnapshot(request: MobilityDashboardRequestR3): Promise<MobilityDashboardSnapshotR3>;
}

/*
 * Contrato futuro: BackendMobilityProviderR3 implementará esta misma interfaz.
 * El frontend consultará exclusivamente al backend de LÍA; el backend consultará
 * Google Routes y normalizará la respuesta. La clave de Google nunca estará en
 * el frontend. No existe conexión, URL ni implementación real en esta fase.
 */
