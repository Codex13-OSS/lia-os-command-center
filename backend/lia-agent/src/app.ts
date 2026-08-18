import cors from 'cors';
import express from 'express';
import type { Express } from 'express';
import type { LiaAgentConfig } from './config.js';
import type { ProjectRegistrySource } from './contracts/projectRegistry.js';
import type { ProjectVerificationRegistry } from './contracts/projectVerification.js';
import { loadConfig } from './config.js';
import { errorHandler } from './middleware/errorHandler.js';
import { notFound } from './middleware/notFound.js';
import { createAgendaRouter } from './routes/agenda.js';
import { createHealthRouter } from './routes/health.js';
import { createHermesRouter } from './routes/hermes.js';
import { createHermesQueryRouter } from './routes/hermesQuery.js';
import { createProjectOrchestrationRouter } from './routes/projectOrchestration.js';
import {
  createProjectTaskExecutionRouter,
  type ProjectTaskExecutionExecutor,
} from './routes/projectTaskExecution.js';
import {
  createProjectTaskWorkflowRouter,
  type ProjectTaskWorkflowExecutor,
} from './routes/projectTaskWorkflow.js';
import { createStatusRouter } from './routes/status.js';
import { createSameOriginStatusRouter } from './routes/sameOriginStatus.js';
import { createProjectTasksRouter, type ProjectTasksDependencies } from './routes/projectTasks.js';
import { createProjectSupervisorRouter } from './routes/projectSupervisor.js';
import { createProjectGoalControlRouter } from './routes/projectGoalControl.js';
import { InMemoryProjectTaskStore } from './services/inMemoryProjectTaskStore.js';
import type { AgendaReadSource } from './services/agendaReadSource.js';
import type { HermesQueryExecutor } from './services/hermesExecutor.js';
import type { ProjectSupervisorSchedulingRuntime } from './services/projectSupervisorSchedulingRuntime.js';

export type LiaAgentDependencies = {
  agendaReadSource?: AgendaReadSource;
  hermesQueryExecutor?: HermesQueryExecutor;
  projectRegistrySource?: ProjectRegistrySource;
  projectOrchestrationExecutor?: HermesQueryExecutor;
  projectTaskExecutionExecutor?: ProjectTaskExecutionExecutor;
  projectVerificationRegistry?: ProjectVerificationRegistry;
  projectTaskWorkflowExecutor?: ProjectTaskWorkflowExecutor;
  projectTaskStore?: ProjectTasksDependencies['store'];
  projectTasksWorkflowExecutor?: ProjectTasksDependencies['executeWorkflow'];
  projectSupervisorRuntime?: ProjectSupervisorSchedulingRuntime;
  /** Clock seam forwarded to the goal control surface (test/qualification only). */
  now?: () => number;
};

export function createApp(
  config: LiaAgentConfig = loadConfig(),
  dependencies: LiaAgentDependencies = {},
): Express {
  const app = express();

  app.disable('x-powered-by');

  if (config.corsOrigins.length > 0) {
    const allowedOrigins = new Set(config.corsOrigins);

    app.use(cors({
      origin(origin, callback) {
        if (origin && allowedOrigins.has(origin)) {
          callback(null, true);
          return;
        }

        callback(null, false);
      },
    }));
  }

  app.use(express.json({ limit: '64kb' }));
  app.use(createHealthRouter());
  app.use(createAgendaRouter(dependencies.agendaReadSource));
  app.use(createStatusRouter());
  app.use(createSameOriginStatusRouter());
  app.use(createHermesRouter(config));
  app.use(createHermesQueryRouter(config, {
    executeQuery: dependencies.hermesQueryExecutor,
    agendaReadSource: dependencies.agendaReadSource,
  }));
  app.use(createProjectOrchestrationRouter(config, {
    projectRegistrySource: dependencies.projectRegistrySource,
    executeQuery: dependencies.projectOrchestrationExecutor,
  }));
  app.use(createProjectTaskExecutionRouter(config, {
    projectRegistrySource: dependencies.projectRegistrySource,
    executeTask: dependencies.projectTaskExecutionExecutor,
  }));
  app.use(createProjectTaskWorkflowRouter(config, {
    projectRegistrySource: dependencies.projectRegistrySource,
    projectVerificationRegistry: dependencies.projectVerificationRegistry,
    executeWorkflow: dependencies.projectTaskWorkflowExecutor,
  }));
  app.use(createProjectTasksRouter(config, {
    store: dependencies.projectTaskStore ?? new InMemoryProjectTaskStore(),
    registry: dependencies.projectRegistrySource,
    verificationRegistry: dependencies.projectVerificationRegistry,
    executeWorkflow: dependencies.projectTasksWorkflowExecutor,
  }));
  app.use(createProjectSupervisorRouter(dependencies.projectSupervisorRuntime));
  // Operator Goal Control Surface — mounted strictly AFTER the supervisor
  // router so `/api/projects/goals/supervisor` never matches `:goalId`
  // (routing-order constraint, design §J).
  app.use(createProjectGoalControlRouter({
    store: dependencies.projectTaskStore ?? new InMemoryProjectTaskStore(),
    config,
    ...(dependencies.projectRegistrySource !== undefined ? { registry: dependencies.projectRegistrySource } : {}),
    ...(dependencies.projectVerificationRegistry !== undefined
      ? { verificationRegistry: dependencies.projectVerificationRegistry }
      : {}),
    ...(dependencies.projectTasksWorkflowExecutor !== undefined
      ? { executeWorkflow: dependencies.projectTasksWorkflowExecutor }
      : {}),
    ...(dependencies.now !== undefined ? { now: dependencies.now } : {}),
  }));
  app.use(notFound);
  app.use(errorHandler);

  return app;
}
