import cors from 'cors';
import express from 'express';
import type { Express } from 'express';
import type { LiaAgentConfig } from './config.js';
import { loadConfig } from './config.js';
import { errorHandler } from './middleware/errorHandler.js';
import { notFound } from './middleware/notFound.js';
import { createAgendaRouter } from './routes/agenda.js';
import { createHealthRouter } from './routes/health.js';
import { createHermesRouter } from './routes/hermes.js';
import { createHermesQueryRouter } from './routes/hermesQuery.js';
import { createStatusRouter } from './routes/status.js';
import type { AgendaReadSource } from './services/agendaReadSource.js';

export type LiaAgentDependencies = {
  agendaReadSource?: AgendaReadSource;
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
  app.use(createHermesRouter(config));
  app.use(createHermesQueryRouter(config));
  app.use(notFound);
  app.use(errorHandler);

  return app;
}
