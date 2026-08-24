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
import { createExecutiveBoardRouter } from './routes/executiveBoard.js';
import { createDecisionLearningRouter } from './routes/decisionLearning.js';
import { createOfficeRouter } from './routes/office.js';
import { createPersonalAuthRouter } from './routes/personalAuth.js';
import type { ExecutiveBoardDecisionStore } from './contracts/executiveBoard.js';
import { InMemoryProjectTaskStore } from './services/inMemoryProjectTaskStore.js';
import type { AgendaReadSource } from './services/agendaReadSource.js';
import type { HermesQueryExecutor } from './services/hermesExecutor.js';
import type { ProjectSupervisorSchedulingRuntime } from './services/projectSupervisorSchedulingRuntime.js';
import type { DecisionLearningGoalSource } from './services/decisionLearningReadModel.js';

function isDecisionLearningGoalSource(value: unknown): value is DecisionLearningGoalSource {
  const source = value as Partial<Record<keyof DecisionLearningGoalSource, unknown>> | null;
  return source !== null && source !== undefined
    && typeof source.readGoal === 'function'
    && typeof source.listGoalAttempts === 'function'
    && typeof source.listGoalEvaluations === 'function';
}

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
  executiveBoardStore?: ExecutiveBoardDecisionStore;
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
  app.use(createPersonalAuthRouter());
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
  // Advisory reads plus append-only outcome recording. Decision creation stays
  // behind the controlled orchestrator and cannot grant or execute capabilities.
  app.use(createExecutiveBoardRouter(dependencies.executiveBoardStore, dependencies.now));
  // Decision Learning V1 is a deterministic projection over existing Board
  // and Goal evidence. This router is GET-only and owns no persistence.
  app.use(createDecisionLearningRouter({
    ...(dependencies.executiveBoardStore !== undefined ? { board: dependencies.executiveBoardStore } : {}),
    ...(isDecisionLearningGoalSource(dependencies.projectTaskStore)
      ? { goals: dependencies.projectTaskStore }
      : {}),
  }));
  // Office V2 is a projection only: GET-only and composed from the existing
  // task, supervisor and Board evidence stores. It owns no write primitive.
  app.use(createOfficeRouter({
    ...(dependencies.projectTaskStore !== undefined ? { store: dependencies.projectTaskStore as never } : {}),
    ...(dependencies.projectSupervisorRuntime !== undefined ? { supervisor: dependencies.projectSupervisorRuntime } : {}),
    ...(dependencies.executiveBoardStore !== undefined ? { board: dependencies.executiveBoardStore } : {}),
    ...(dependencies.now !== undefined ? { now: dependencies.now } : {}),
  }));
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
    onRootTaskTerminalized: (): void => { dependencies.projectSupervisorRuntime?.requestPass('terminalization'); },
    ...(dependencies.now !== undefined ? { now: dependencies.now } : {}),
  }));
  app.use(notFound);
  app.use(errorHandler);

  return app;
}
