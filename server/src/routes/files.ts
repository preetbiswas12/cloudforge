import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { tokenGuard } from '../middleware/auth.js';
import type { WorkspaceService } from '../fs/workspace.js';
import type { GitRepo } from '../git/repo.js';
import type { Hub } from '../realtime/hub.js';

const pathField = z.string().max(4096);
const writeBody = z.object({
  path: pathField,
  content: z.string(),
});
const createBody = z.object({ path: pathField });
const renameBody = z.object({ from: pathField, to: pathField });
const queryPath = z.object({ path: z.string().max(4096).optional().default('') });

/**
 * Express 4 does not catch rejected promises from async handlers, which would
 * leave a rejected `throw` (a blocked path traversal, say) hanging forever.
 * This forwards errors to the error middleware instead.
 */
function asyncHandler(handler: RequestHandler): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

export function createFilesRouter(deps: {
  workspace: WorkspaceService;
  repo: GitRepo;
  hub: Hub;
}): Router {
  const { workspace, repo, hub } = deps;
  const router = Router();

  // Every route below requires the token when EDITOR_TOKEN is configured.
  router.use(tokenGuard);

  router.get(
    '/files',
    asyncHandler(async (req, res) => {
      const { path } = queryPath.parse(req.query);
      res.json(await workspace.list(path));
    }),
  );

  // Flat list of every file, used by the quick-open palette (Ctrl+P).
  router.get(
    '/files/all',
    asyncHandler(async (_req, res) => {
      res.json({ paths: await workspace.walk() });
    }),
  );

  router.get(
    '/file',
    asyncHandler(async (req, res) => {
      const { path } = queryPath.parse(req.query);
      res.json(await workspace.read(path));
    }),
  );

  router.put(
    '/file',
    asyncHandler(async (req, res) => {
      const { path, content } = writeBody.parse(req.body);
      res.json(await workspace.write(path, content));
    }),
  );

  router.post(
    '/file',
    asyncHandler(async (req, res) => {
      const { path } = createBody.parse(req.body);
      res.status(201).json(await workspace.createFile(path));
    }),
  );

  router.post(
    '/folder',
    asyncHandler(async (req, res) => {
      const { path } = createBody.parse(req.body);
      res.status(201).json(await workspace.createFolder(path));
    }),
  );

  router.post(
    '/rename',
    asyncHandler(async (req, res) => {
      const { from, to } = renameBody.parse(req.body);
      res.json(await workspace.rename(from, to));
    }),
  );

  router.delete(
    '/file',
    asyncHandler(async (req, res) => {
      const { path } = queryPath.parse(req.query);
      res.json(await workspace.remove(path));
    }),
  );

  router.get(
    '/status',
    asyncHandler(async (_req, res) => {
      const [git, tree] = await Promise.all([repo.status(), workspace.list('')]);
      res.json({
        root: workspace.root,
        entries: tree.entries.length,
        git,
        peers: hub.peerCount,
      });
    }),
  );

  router.get(
    '/history',
    asyncHandler(async (req, res) => {
      const limit = Math.min(Number(req.query['limit'] ?? 20) || 20, 100);
      res.json({ commits: await repo.log(limit) });
    }),
  );

  // Manual "save version" button in the UI.
  router.post(
    '/snapshot',
    asyncHandler(async (_req, res) => {
      res.json(await repo.snapshot(`chore: snapshot ${new Date().toISOString()}`));
    }),
  );

  return router;
}