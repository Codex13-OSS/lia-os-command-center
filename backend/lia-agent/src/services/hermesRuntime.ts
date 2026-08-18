import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import type { HermesRuntimeProbe } from '../contracts/hermes.js';

const REQUIRED_RUNTIME_MARKERS = [
  'run_agent.py',
  'hermes_state.py',
  'tools/registry.py',
  'gateway/run.py',
] as const;

async function isReadable(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export async function inspectHermesRuntime(hermesRoot: string): Promise<HermesRuntimeProbe> {
  if (hermesRoot === '') {
    return {
      configured: false,
      runtimeDetected: false,
      state: 'unconfigured',
      requiredMarkers: REQUIRED_RUNTIME_MARKERS.length,
      detectedMarkers: 0,
    };
  }

  const results = await Promise.all(
    REQUIRED_RUNTIME_MARKERS.map((marker) => isReadable(join(hermesRoot, marker))),
  );
  const detectedMarkers = results.filter(Boolean).length;
  const runtimeDetected = detectedMarkers === REQUIRED_RUNTIME_MARKERS.length;

  return {
    configured: true,
    runtimeDetected,
    state: runtimeDetected ? 'available' : 'unavailable',
    requiredMarkers: REQUIRED_RUNTIME_MARKERS.length,
    detectedMarkers,
  };
}
