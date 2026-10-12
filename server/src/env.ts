import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

dotenv.config();

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(serverDir, '..');

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function int(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function abs(p: string, base: string): string {
  return path.isAbsolute(p) ? p : path.resolve(base, p);
}

export const env = {
  nodeEnv: process.env['NODE_ENV'] ?? 'development',
  port: int(process.env['PORT'], 8080),
  workspaceDir: abs(process.env['WORKSPACE_DIR'] ?? './workspace', repoRoot),
  webDist: abs(process.env['WEB_DIST'] ?? './web/dist', repoRoot),

  editorToken: (process.env['EDITOR_TOKEN'] ?? '').trim(),

  terminal: {
    /**
     * Off by default. Even when enabled, TerminalManager refuses to open a
     * session unless editorToken is also set — a shell on an open instance is
     * a remote shell for anyone who finds the URL.
     */
    enabled: bool(process.env['TERMINAL_ENABLED'], false),
    /**
     * Resolved per-platform. On Linux (Render/Railway/Fly) this is `/bin/sh`.
     *
     * On Windows we deliberately use `cmd.exe`, not PowerShell: PowerShell
     * produces no output when its stdin is a pipe rather than a real console,
     * which makes it useless for a web terminal without a native PTY.
     * Override with TERMINAL_SHELL.
     */
    shell:
      (process.env['TERMINAL_SHELL'] ?? '').trim() ||
      (process.platform === 'win32' ? 'cmd.exe' : '/bin/sh'),
    /** Extra args, since shells disagree about how to be told "interactive". */
    shellArgs: process.platform === 'win32' ? ['/Q'] : ['-i'],
    /**
     * PATH for the child process. This doubles as the search path Node uses to
     * resolve the shell binary itself, so it has to contain the directory the
     * shell actually lives in — PowerShell is not in System32.
     */
    shellPath:
      process.platform === 'win32'
        ? [
            process.env['SystemRoot'] ?? 'C:\\Windows',
            `${process.env['SystemRoot'] ?? 'C:\\Windows'}\\System32`,
            `${process.env['SystemRoot'] ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0`,
            'C:\\Program Files\\Git\\usr\\bin',
          ].join(';')
        : '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
  },

  git: {
    enabled: bool(process.env['GIT_ENABLED'], true),
    authorName: process.env['GIT_AUTHOR_NAME'] ?? 'CloudForge',
    authorEmail: process.env['GIT_AUTHOR_EMAIL'] ?? 'cloudforge@localhost',
    branch: process.env['GIT_BRANCH'] ?? 'main',
    remote: (process.env['GIT_REMOTE'] ?? '').trim(),
    remoteToken: (process.env['GIT_REMOTE_TOKEN'] ?? '').trim(),
    pullOnBoot: bool(process.env['GIT_PULL_ON_BOOT'], true),
    autoCommit: bool(process.env['AUTO_COMMIT'], true),
    snapshotIntervalMs: int(process.env['SNAPSHOT_INTERVAL_MS'], 5 * 60 * 1000),
  },

  maxFileBytes: int(process.env['MAX_FILE_BYTES'], 2 * 1024 * 1024),
  logLevel: process.env['LOG_LEVEL'] ?? 'info',
} as const;

export const isProduction = env.nodeEnv === 'production';