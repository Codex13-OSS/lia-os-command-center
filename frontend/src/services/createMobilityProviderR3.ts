import { MockMobilityProviderR3 } from './mockMobilityProviderR3';
import type { MobilityProviderR3 } from './mobilityProviderR3';
import { mobilityDashboardRequestR3 } from '../data/mobilityR3MockData';
import type { MobilityDashboardRequestR3 } from '../domain/mobilityR3';

export type MobilityProviderSelectionR3 = 'mock' | 'backend';

// Único punto de configuración: cambiar 'mock' por 'backend' cuando exista su implementación autorizada.
export const mobilityProviderSelectionR3: MobilityProviderSelectionR3 = 'mock';
export const initialMobilityDashboardRequestR3: MobilityDashboardRequestR3 = mobilityDashboardRequestR3;

export class MobilityProviderNotConfiguredErrorR3 extends Error {}

export function createMobilityProviderR3(selection: MobilityProviderSelectionR3): MobilityProviderR3 {
  if (selection === 'mock') return new MockMobilityProviderR3();
  return {
    async getDashboardSnapshot() {
      throw new MobilityProviderNotConfiguredErrorR3('Mobility backend provider is not configured');
    },
  };
}
