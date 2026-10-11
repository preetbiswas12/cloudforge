import type { IncomingMessage, ServerResponse } from 'node:http';
import pino from 'pino';
import { pinoHttp } from 'pino-http';
import { env, isProduction } from './env.js';

export const logger = pino({
  level: isProduction ? env.logLevel : env.logLevel === 'info' ? 'debug' : env.logLevel,
  base: { service: 'cloudforge' },
  // Never let access tokens reach the log stream.
  redact: {
    paths: ['req.headers["x-editor-token"]', 'req.headers.authorization'],
    remove: true,
  },
});

export const httpLogger = pinoHttp({
  logger,
  // Keep the log readable: health checks and static assets are noise.
  autoLogging: {
    ignore: (req: IncomingMessage) =>
      req.url === '/api/health' || req.url?.startsWith('/assets/') === true,
  },
  customLogLevel: (_req: IncomingMessage, res: ServerResponse, err?: Error) => {
    if (err || res.statusCode >= 500) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'debug';
  },
});