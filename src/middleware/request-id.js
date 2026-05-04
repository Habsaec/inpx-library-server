import { randomUUID } from 'node:crypto';

const REQUEST_ID_HEADER = 'x-request-id';

/**
 * Express middleware: attaches a unique request ID to every request.
 * Propagates client-provided ID if present and valid, otherwise generates a new UUID.
 */
export function requestId(req, res, next) {
  const clientId = String(req.get(REQUEST_ID_HEADER) || '').trim();
  req.id = /^[a-zA-Z0-9_-]{1,64}$/.test(clientId) ? clientId : randomUUID();
  res.set(REQUEST_ID_HEADER, req.id);
  next();
}
