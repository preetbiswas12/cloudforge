import crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { RequestHandler } from 'express';
import { env } from '../env.js';
import { HttpError } from '../errors.js';

/**
 * Optional shared-secret gate.
 *
 * The editor is public by default — set EDITOR_TOKEN to require a token, which
 * is the cheapest way to keep a public domain from being vandalised before you
 * are ready to build real accounts.
 */
export function constantTimeEquals(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  if (bufferA.length !== bufferB.length) return false;
  return crypto.timingSafeEqual(bufferA, bufferB);
}

/** Pull a token from the header, the query string, or the session cookie. */
export function extractToken(req: { headers: Record<string, unknown>; query: Record<string, unknown> } & {
  cookies?: Record<string, string | undefined>;
}): string | null {
  const header = req.headers['x-editor-token'];
  if (typeof header === 'string' && header) return header;

  const queryToken = req.query['token'];
  if (typeof queryToken === 'string' && queryToken) return queryToken;

  const cookieToken = req.cookies?.['cf_token'];
  if (typeof cookieToken === 'string' && cookieToken) return cookieToken;

  return null;
}

/** Express middleware guarding the API routes. */
export const tokenGuard: RequestHandler = (req, _res, next) => {
  if (!env.editorToken) return next();

  const provided = extractToken(req as never);
  if (provided && constantTimeEquals(provided, env.editorToken)) return next();

  next(new HttpError(401, 'A valid editor token is required', 'unauthorized'));
};

/**
 * Gate for the WebSocket upgrade. Reuses the same token, which the client
 * sends as a query parameter because browsers cannot set headers on upgrade.
 */
export function authorizeUpgrade(req: IncomingMessage): boolean {
  if (!env.editorToken) return true;
  const url = new URL(req.url ?? '/', 'http://localhost');
  const provided = url.searchParams.get('token');
  return Boolean(provided && constantTimeEquals(provided, env.editorToken));
}