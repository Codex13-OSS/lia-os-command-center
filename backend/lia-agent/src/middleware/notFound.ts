import type { RequestHandler } from 'express';

export const notFound: RequestHandler = (request, response) => {
  response.status(404).json({
    ok: false,
    error: 'not_found',
    path: request.path,
  });
};
