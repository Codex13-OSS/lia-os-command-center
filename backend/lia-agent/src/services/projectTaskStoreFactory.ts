import type { LiaAgentConfig } from '../config.js';
import type { ProjectTaskStore } from '../contracts/projectTask.js';
import { InMemoryProjectTaskStore } from './inMemoryProjectTaskStore.js';
import { ProjectTaskSqliteStore } from './projectTaskSqliteStore.js';

/**
 * Selects the ProjectTaskStore used by the server bootstrap.
 *
 * An empty configured path keeps the in-memory store; a configured path
 * builds the durable SQLite store. The SQLite store fails closed on any
 * initialization error: there is no silent fallback to memory here.
 */
export function createProjectTaskStore(config: LiaAgentConfig): ProjectTaskStore {
  if (config.projectTaskSqlitePath === '') {
    return new InMemoryProjectTaskStore();
  }

  return new ProjectTaskSqliteStore({ databasePath: config.projectTaskSqlitePath });
}
