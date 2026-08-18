import type { RequestHandler } from 'express';

export function methodNotAllowed(allowedMethods: string[]): RequestHandler {
  return (_request, response) => {
    response.setHeader('Allow', allowedMethods.join(', '));
    response.status(405).json({
      ok: false,
      error: 'method_not_allowed',
      allowedMethods,
    });
  };
}
