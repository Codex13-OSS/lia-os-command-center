import type { ErrorRequestHandler } from 'express';

export const errorHandler: ErrorRequestHandler = (_error, _request, response, _next) => {
  if (response.headersSent) {
    return;
  }

  response.status(500).json({
    ok: false,
    error: 'internal_error',
  });
};
