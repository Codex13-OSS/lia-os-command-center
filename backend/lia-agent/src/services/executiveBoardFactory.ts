import type { LiaAgentConfig } from '../config.js';
import type { ExecutiveBoardDecisionStore } from '../contracts/executiveBoard.js';
import type { HermesQueryExecutor } from './hermesExecutor.js';
import { createExecutiveBoardHermesSpecialistAdapter } from './executiveBoardHermesSpecialistAdapter.js';
import { createExecutiveBoardOrchestrator } from './executiveBoardOrchestrator.js';

/** Controlled composition root. It does not expose an HTTP creation route. */
export function createHermesExecutiveBoardOrchestrator(dependencies: {
  config: LiaAgentConfig;
  store: ExecutiveBoardDecisionStore;
  executeSupervisor?: HermesQueryExecutor;
  now?: () => number;
  createId?: () => string;
}) {
  return createExecutiveBoardOrchestrator({
    specialists: createExecutiveBoardHermesSpecialistAdapter({
      config: dependencies.config,
      ...(dependencies.executeSupervisor ? { executeSupervisor: dependencies.executeSupervisor } : {}),
    }),
    store: dependencies.store,
    ...(dependencies.now ? { now: dependencies.now } : {}),
    ...(dependencies.createId ? { createId: dependencies.createId } : {}),
  });
}