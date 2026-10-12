import http from 'node:http';
import fs from 'node:fs/promises';
import { env } from './env.js';
import { logger } from './logger.js';
import { createApp } from './app.js';
import { WorkspaceService } from './fs/workspace.js';
import { Watcher } from './fs/watcher.js';
import { seedWorkspace } from './fs/seed.js';
import { GitRepo } from './git/repo.js';
import { Hub, type ClientEvent, type ServerEvent } from './realtime/hub.js';
import { authorizeUpgrade } from './middleware/auth.js';
import { TerminalManager } from './terminal/manager.js';

/**
 * Map a websocket client to the terminal sessions it owns, so one browser
 * can never read or type into another browser's shell.
 */
const terminalSessions = new Map<string, Set<string>>();

async function main(): Promise<void> {
  await fs.mkdir(env.workspaceDir, { recursive: true });

  const workspace = new WorkspaceService(env.workspaceDir);
  const repo = new GitRepo(env.workspaceDir);
  const hub = new Hub();

  // Order matters: seed and restore from the remote *before* the watcher
  // starts, so a pull is not broadcast as a burst of change events to clients.
  const { created } = await repo.ensure();
  if (created) await seedWorkspace(workspace);
  await repo.pullOnBoot();
  if (created) await repo.commit('chore: initialise workspace', { allowEmpty: true });

  const watcher = new Watcher(env.workspaceDir, hub);
  await watcher.start();

  const terminal = new TerminalManager();
  const terminalSweeper = terminal.startSweeper();

  const app = createApp({ workspace, repo, hub, terminal });
  const server = http.createServer(app);

  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  hub.attach(server, '/ws', authorizeUpgrade);

  if (terminal.blockedReason) {
    logger.info({ reason: terminal.blockedReason }, 'Web terminal unavailable');
  } else {
    logger.warn('Web terminal ENABLED — anyone with the editor token gets a shell on this server');
  }

  hub.setMessageHandler((clientId, message: ClientEvent) => {
    const owned = terminalSessions.get(clientId);

    switch (message.type) {
      case 'terminal:open': {
        try {
          const sessionId = terminal.open(env.workspaceDir, {
            send: (event) => hub.sendTo(clientId, event as ServerEvent),
            close: () => {
              owned?.delete(sessionId);
              if (owned?.size === 0) terminalSessions.delete(clientId);
            },
          });

          const sessions = terminalSessions.get(clientId) ?? new Set<string>();
          sessions.add(sessionId);
          terminalSessions.set(clientId, sessions);

          hub.sendTo(clientId, { type: 'toast', level: 'info', message: 'Terminal session started' });
        } catch (error) {
          const reason = error instanceof Error ? error.message : 'Could not start the terminal';
          logger.warn({ err: error, clientId }, 'Terminal open refused');
          hub.sendTo(clientId, { type: 'toast', level: 'error', message: reason });
        }
        return;
      }

      case 'terminal:input': {
        if (message.sessionId && owned?.has(message.sessionId) && typeof message.data === 'string') {
          terminal.write(message.sessionId, message.data);
        }
        return;
      }

      case 'terminal:close': {
        if (message.sessionId && owned?.has(message.sessionId)) {
          terminal.close(message.sessionId);
          owned.delete(message.sessionId);
        }
        return;
      }

      default:
        return;
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(env.port, '0.0.0.0', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  logger.info(
    {
      port: env.port,
      workspace: env.workspaceDir,
      authRequired: Boolean(env.editorToken),
      env: env.nodeEnv,
    },
    'CloudForge is online',
  );

  // Periodically snapshot the workspace so a redeploy never loses work.
  let snapshotTimer: NodeJS.Timeout | null = null;
  if (env.git.enabled && env.git.autoCommit) {
    snapshotTimer = setInterval(() => {
      void (async () => {
        if (!(await repo.hasChanges())) return;
        await repo.snapshot(`chore: autosave ${new Date().toISOString()}`);
      })();
    }, env.git.snapshotIntervalMs);
    snapshotTimer.unref?.();
  }

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down');

    if (snapshotTimer) clearInterval(snapshotTimer);
    clearInterval(terminalSweeper);
    terminal.closeAll();

    // Flush pending work before the process goes away.
    if (env.git.enabled && (await repo.hasChanges())) {
      await repo.snapshot('chore: autosave on shutdown');
    }

    await watcher.close();
    await hub.close();

    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      setTimeout(resolve, 8000).unref?.();
    });

    process.exit(0);
  };

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void shutdown(signal);
    });
  }

  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'Unhandled promise rejection');
  });
}

main().catch((error) => {
  logger.fatal({ err: error }, 'Failed to start CloudForge');
  process.exit(1);
});