import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import { env } from '../env.js';
import { logger } from '../logger.js';

/** Hard limits so a runaway script cannot take the instance down. */
const LIMITS = {
  maxSessions: 4,
  maxOutputBytes: 512 * 1024,
  idleTimeoutMs: 30 * 60 * 1000,
  lifetimeMs: 12 * 60 * 60 * 1000,
} as const;

export interface TerminalEvent {
  type: 'terminal:output' | 'terminal:exit';
  sessionId: string;
  data?: string;
  code?: number | null;
}

export interface TerminalSink {
  send(event: TerminalEvent): void;
  close(): void;
}

interface Session {
  id: string;
  child: ChildProcess;
  createdAt: number;
  lastActivity: number;
  buffer: string;
  sink: TerminalSink;
  killTimer: NodeJS.Timeout | null;
}

/**
 * Manages optional shell sessions for the web terminal.
 *
 * This is only reachable when TERMINAL_ENABLED=true, which the operator must
 * also pair with EDITOR_TOKEN. Even then these rules apply:
 *
 *  - The child NEVER receives our environment. GIT_REMOTE_TOKEN and
 *    EDITOR_TOKEN are deliberately absent, so a shell cannot steal the
 *    credentials CloudForge itself uses.
 *  - There is no PTY, so this is a plain pipe session: `node app.js`,
 *    `npm test` and `ls` work; full-screen TUI programs (vim, top) do not.
 *  - Sessions are capped, idle sessions are killed, and the whole process
 *    group is killed so orphaned grandchildren cannot survive.
 */
export class TerminalManager {
  private readonly sessions = new Map<string, Session>();

  /**
   * Terminals are refused unless the instance also requires a token. On a
   * wide-open public instance this turns "anyone can get a shell" into an
   * error message instead of a remote shell.
   */
  get enabled(): boolean {
    return env.terminal.enabled;
  }

  get blockedReason(): string | null {
    if (!env.terminal.enabled) {
      return 'The terminal is disabled. Set TERMINAL_ENABLED=true on the server to turn it on.';
    }
    if (!env.editorToken) {
      return 'The terminal requires a protected workspace. Set EDITOR_TOKEN before enabling TERMINAL_ENABLED.';
    }
    return null;
  }

  get sessionCount(): number {
    return this.sessions.size;
  }

  open(workspaceDir: string, sink: TerminalSink): string {
    const blocked = this.blockedReason;
    if (blocked) throw new Error(blocked);

    if (this.sessions.size >= LIMITS.maxSessions) {
      throw new Error(`Too many open terminals (limit ${LIMITS.maxSessions}).`);
    }

    const id = crypto.randomBytes(9).toString('hex');

    // `detached` puts the child in its own process group so we can signal the
    // entire tree, not just the shell.
    const child = spawn(env.terminal.shell, env.terminal.shellArgs, {
      cwd: workspaceDir,
      // A deliberately minimal environment. Nothing secret crosses this line.
      env: {
        PATH: env.terminal.shellPath,
        HOME: workspaceDir,
        TERM: 'dumb',
        LANG: 'C.UTF-8',
        SHELL: env.terminal.shell,
        PWD: workspaceDir,
        USER: 'sandbox',
        CF_TERMINAL: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });

    const now = Date.now();
    const session: Session = {
      id,
      child,
      createdAt: now,
      lastActivity: now,
      buffer: '',
      sink,
      killTimer: null,
    };
    this.sessions.set(id, session);

    const write = (chunk: Buffer, stream: 'stdout' | 'stderr') => {
      const text = chunk.toString('utf8');
      this.touch(id);
      this.append(session, stream === 'stderr' ? `\x1b[31m${text}\x1b[0m` : text);
    };

    child.stdout?.on('data', (chunk: Buffer) => write(chunk, 'stdout'));
    child.stderr?.on('data', (chunk: Buffer) => write(chunk, 'stderr'));

    child.on('exit', (code) => {
      this.sessions.delete(id);
      if (session.killTimer) clearTimeout(session.killTimer);
      sink.send({ type: 'terminal:exit', sessionId: id, code });
      sink.close();
      logger.info({ id, code }, 'Terminal session ended');
    });

    child.on('error', (error: NodeJS.ErrnoException) => {
      const hint =
        error.code === 'ENOENT'
          ? `\r\n\x1b[31mShell "${env.terminal.shell}" was not found on this server.\x1b[0m`
          : `\r\n\x1b[31m${error.message}\x1b[0m`;
      this.append(session, hint);
      this.sessions.delete(id);
      sink.close();
      logger.warn({ err: error, id }, 'Terminal session error');
    });

    this.append(
      session,
      `\x1b[2mCloudForge shell — cwd is your workspace.\x1b[0m\r\n` +
        `\x1b[2mSessions are capped at ${LIMITS.maxSessions} and idle shells close after ` +
        `${LIMITS.idleTimeoutMs / 60000} minutes.\x1b[0m\r\n\r\n`,
    );

    logger.warn({ id, shell: env.terminal.shell }, 'Terminal session opened');
    return id;
  }

  write(sessionId: string, data: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.touch(sessionId);

    // Cap what a client can push in, so one tab can't flood the shell.
    if (data.length > 4096) data = data.slice(0, 4096);

    session.child.stdin?.write(data);
  }

  close(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.terminate(session);
  }

  closeAll(): void {
    for (const session of [...this.sessions.values()]) this.terminate(session);
  }

  private touch(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.lastActivity = Date.now();
    if (session.killTimer) clearTimeout(session.killTimer);

    session.killTimer = setTimeout(() => {
      const current = this.sessions.get(sessionId);
      if (!current) return;
      this.append(current, '\r\n\x1b[2m[closed after inactivity]\x1b[0m\r\n');
      this.terminate(current);
    }, LIMITS.idleTimeoutMs);
    session.killTimer.unref?.();
  }

  /** Ring-buffer the output so a runaway loop cannot exhaust memory. */
  private append(session: Session, text: string): void {
    session.buffer += text;
    if (session.buffer.length > LIMITS.maxOutputBytes) {
      session.buffer = session.buffer.slice(-LIMITS.maxOutputBytes);
    }
    session.sink.send({ type: 'terminal:output', sessionId: session.id, data: text });
  }

  /** Kill the whole process group so no orphaned grandchildren survive. */
  private terminate(session: Session): void {
    if (session.killTimer) clearTimeout(session.killTimer);
    this.sessions.delete(session.id);

    const pid = session.child.pid;
    if (pid === undefined) return;

    try {
      if (process.platform === 'win32') {
        // Windows has no process groups, so taskkill walks the tree.
        spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
      } else {
        // Negative pid signals the whole group created by `detached: true`.
        process.kill(-pid, 'SIGTERM');
        setTimeout(() => {
          try {
            process.kill(-pid, 'SIGKILL');
          } catch {
            // Already gone.
          }
        }, 3000).unref?.();
      }
    } catch (error) {
      logger.warn({ err: error, pid }, 'Failed to kill terminal process group');
    }

    session.sink.close();
  }

  /** Periodic sweep: drop sessions past their absolute lifetime. */
  startSweeper(): NodeJS.Timeout {
    const timer = setInterval(() => {
      const now = Date.now();
      for (const session of [...this.sessions.values()]) {
        if (now - session.createdAt > LIMITS.lifetimeMs) this.terminate(session);
      }
    }, 60_000);
    timer.unref?.();
    return timer;
  }
}