import path from 'node:path';
import fs from 'node:fs';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import { ZodError } from 'zod';
import { env, isProduction } from './env.js';
import { httpLogger, logger } from './logger.js';
import { HttpError } from './errors.js';
import { createFilesRouter } from './routes/files.js';
import type { WorkspaceService } from './fs/workspace.js';
import type { GitRepo } from './git/repo.js';
import type { Hub } from './realtime/hub.js';

export function createApp(deps: {
  workspace: WorkspaceService;
  repo: GitRepo;
  hub: Hub;
}): Express {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', true); // correct client IPs behind Nginx/Render/Railway

  app.use(httpLogger);

  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        // Monaco injects styles at runtime and evaluates user code in a worker.
        "style-src 'self' 'unsafe-inline'",
        "script-src 'self' 'unsafe-eval'",
        "worker-src 'self' blob:",
        "img-src 'self' data: blob:",
        "font-src 'self' data:",
        "connect-src 'self' ws: wss:",
      ].join('; '),
    );
    next();
  });

  // Same-origin in production; open CORS in dev so Vite (5173) can talk to the API (8080).
  app.use(cors(isProduction ? { origin: false } : { origin: true, credentials: true }));

  // The sandboxed HTML preview posts back to nothing, but allow large-ish writes.
  app.use(express.json({ limit: '4mb' }));

  // Unauthenticated: platform health checks must not need a token.
  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      uptimeSeconds: Math.round(process.uptime()),
      version: '1.0.0',
      time: new Date().toISOString(),
    });
  });

  app.get('/api/config', (_req, res) => {
    res.json({
      // Tells the client to show a token prompt.
      requiresToken: Boolean(env.editorToken),
      maxFileBytes: env.maxFileBytes,
    });
  });

  app.use('/api', createFilesRouter(deps));

  // Serve the built SPA when it exists. In development Vite serves it instead.
  if (fs.existsSync(env.webDist)) {
    app.use(
      express.static(env.webDist, {
        index: false,
        maxAge: isProduction ? '1h' : 0,
        setHeaders: (res, filePath) => {
          // Vite emits content-hashed asset filenames, so they are safe to pin.
          if (filePath.includes(`${path.sep}assets${path.sep}`)) {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          }
        },
      }),
    );

    // SPA fallback — every other GET returns index.html.
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api') || req.path.startsWith('/ws')) return next();
      res.sendFile(path.join(env.webDist, 'index.html'));
    });
  } else {
    logger.warn({ webDist: env.webDist }, 'Web client is not built yet — run `npm run build` (dev mode uses Vite)');
  }

  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof HttpError) {
      res.status(error.status).json({ error: error.message, code: error.code });
      return;
    }
    if (error instanceof ZodError) {
      res.status(400).json({
        error: 'Invalid request',
        code: 'bad_request',
        details: error.issues.map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`),
      });
      return;
    }

    logger.error({ err: error }, 'Unhandled error');
    res.status(500).json({ error: 'Internal server error', code: 'internal' });
  });

  return app;
}